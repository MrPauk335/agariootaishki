'use strict';
/* ============================================================
   CELL ROYALE — Authoritative Game Server
   Node.js + Express + Socket.IO
   ============================================================ */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

/* ---------------------- CONFIG ---------------------- */
const CFG = {
    PORT: +(process.env.PORT || 3000),
    MAP: 4000,
    SIM_HZ: 30,
    NET_HZ: 15, // хватает 15 тиков/сек: клиент интерполирует позиции. Снижает трафик snap'ов вдвое.
    FOOD_NET_EVERY: 4,

    MAX_PLAYERS: 20,
    MIN_HUMANS: +(process.env.MIN_HUMANS || 2),
    LOBBY_MS: +(process.env.LOBBY_MS || 5000),
    BOTS: false,
    BOT_FILL: 0,
    FOG: process.env.FOG !== '0',
    MATCH_MS: 8 * 60 * 1000,
    ADMIN_KEY: process.env.ADMIN_KEY || 'pauk123',

    START_MASS: 30,
    MIN_MASS: 10,

    FOOD: 1000,
    FOOD_MASS: 1.3,
    VIRUS: 26,
    VIRUS_MASS: 110,
    VIRUS_MAX: 220,

    MAX_CELLS: 16,
    SPLIT_MIN: 42,
    SPLIT_BOOST: 750,
    EJECT_MIN: 34,
    EJECT_COST: 18,
    EJECT_MASS: 13,
    EJECT_BOOST: 880,
    VIRUS_POP_MIN: 135,

    EAT_RATIO: 1.15,
    EAT_OVER: 0.45,

    DECAY_BASE: 0,
    DECAY_MASS: 0,
    TOP_MULT: [1, 1, 1],

    ZONE_START_R: 2600,
    ZONE_PHASES: [
        { wait: 5000, shrink: 15000, r: 2400, dps: 3 },
        { wait: 2000, shrink: 15000, r: 1500, dps: 8 },
        { wait: 1000, shrink: 15000, r: 750, dps: 15 },
        { wait: 0, shrink: 15000, r: 180, dps: 30 }
    ],
    ZONE_PCT_DPS: 0.015,
    FINAL_STANDOFF_MS: +(process.env.FINAL_STANDOFF_MS || 10000), // после финального сжатия зоны: 10 сек на развязку, потом побеждает самый массивный
};

/* ---------------------- UTILS ---------------------- */
const T = () => Date.now();
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const radius = m => 4 * Math.sqrt(Math.max(1, m));
const speedOf = m => Math.max(55, 760 * Math.pow(Math.max(1, m), -0.28));
const mergeTime = m => 5000 + Math.min(8000, m * 20);
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

let seq = 1;
const nid = () => seq++;

function sanitizeName(n) {
    n = String(n || '').replace(/[<>&"'`\r\n\t]/g, '').trim().slice(0, 14);
    return n || 'Cell';
}

/* ---------------------- STATE ---------------------- */
const state = {
    phase: 'lobby',       // lobby | live | over
    cdEnd: 0,
    finalEnd: 0,          // >0: по этой метке времени заканчивается финальный отсчёт (после последнего сжатия зоны)
    matchStart: 0,
    matchEnd: 0,
    players: new Map(),   // pid -> player
    bySocket: new Map(),  // socket.id -> pid
    food: [],
    viruses: [],
    ejects: [],
    zone: null,
    events: [],           // [{type, x, y, r}]
    winner: null,
    startedCount: 0,
    netFrame: 0,
    hostPid: null,
};

/* ---------------------- FACTORIES ---------------------- */
function newPlayer(sid, name, isBot = false) {
    return {
        pid: nid(), sid, name: sanitizeName(name), isBot,
        color: (Math.random() * 10) | 0,
        status: 'menu',    // menu | ready | alive | dead | spectator
        hasJoined: false,
        cells: [],
        aim: { x: 0, y: -200 },
        total: 0, rank: 99, kills: 0, maxMass: 0, place: 0,
        matchTimeStart: 0,          // T() старта текущего матча для этого игрока (0 = не в матче)
        lastSplit: 0, lastEject: 0,
        specPid: null, killerName: null,
        bot: { targetTime: 0, tx: 2000, ty: 2000, aggressive: rnd(0.3, 0.9) },
    };
}

function spawnFoodAt(i) {
    const z = state.zone;
    let x, y;
    if (z && Math.random() < 0.85) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * z.r * 0.9;
        x = clamp(z.x + Math.cos(a) * r, 20, CFG.MAP - 20);
        y = clamp(z.y + Math.sin(a) * r, 20, CFG.MAP - 20);
    } else {
        x = rnd(20, CFG.MAP - 20);
        y = rnd(20, CFG.MAP - 20);
    }
    const f = { x: Math.round(x), y: Math.round(y), m: CFG.FOOD_MASS };
    if (i === undefined) state.food.push(f);
    else state.food[i] = f;
}

function resetWorld() {
    state.food = [];
    state.viruses = [];
    state.ejects = [];
    state.events = [];

    const z0 = CFG.ZONE_PHASES[0];
    state.zone = {
        x: CFG.MAP / 2, y: CFG.MAP / 2, r: CFG.ZONE_START_R,
        nx: CFG.MAP / 2, ny: CFG.MAP / 2, nr: z0.r,
        ph: 0, st: 'wait', t0: T(), t1: T() + z0.wait,
    };

    for (let i = 0; i < CFG.FOOD; i++) spawnFoodAt();
            for (let i = 0; i < CFG.VIRUS; i++) {
                state.viruses.push({
                    id: nid(),
                    x: rnd(200, CFG.MAP - 200),
                    y: rnd(200, CFG.MAP - 200),
                    m: CFG.VIRUS_MASS, vx: 0, vy: 0,
                });
            }
    state.finalEnd = 0; // сброс финального отсчёта на новый матч
}

/* ---------------------- ZONE LOGIC ---------------------- */
function getCurrentZone() {
    const z = state.zone;
    if (!z) return { x: CFG.MAP / 2, y: CFG.MAP / 2, r: CFG.ZONE_START_R, dps: 2 };
    const phCfg = CFG.ZONE_PHASES[z.ph] || CFG.ZONE_PHASES[CFG.ZONE_PHASES.length - 1];

    if (z.st === 'shrink') {
        const p = clamp((T() - z.t0) / (z.t1 - z.t0 || 1), 0, 1);
        return {
            x: z.x + (z.nx - z.x) * p,
            y: z.y + (z.ny - z.y) * p,
            r: z.r + (z.nr - z.r) * p,
            dps: phCfg.dps,
        };
    }
    return { x: z.x, y: z.y, r: z.r, dps: phCfg.dps };
}

function updateZone() {
    const z = state.zone;
    if (!z || state.phase !== 'live') return;
    const now = T();

    if (now >= z.t1) {
        if (z.st === 'wait') {
            // Transition from wait to shrink
            z.st = 'shrink';
            z.t0 = now;
            z.t1 = now + CFG.ZONE_PHASES[z.ph].shrink;
        } else if (z.st === 'shrink') {
            // Transition from shrink to next phase wait
            z.x = z.nx; z.y = z.ny; z.r = z.nr;
            z.ph++;
            if (z.ph < CFG.ZONE_PHASES.length) {
                const nxt = CFG.ZONE_PHASES[z.ph];
                const maxOffset = Math.max(0, z.r - nxt.r);
                const ang = Math.random() * Math.PI * 2;
                const offset = Math.random() * maxOffset;

                z.nx = clamp(z.x + Math.cos(ang) * offset, nxt.r + 50, CFG.MAP - nxt.r - 50);
                z.ny = clamp(z.y + Math.sin(ang) * offset, nxt.r + 50, CFG.MAP - nxt.r - 50);
                z.nr = nxt.r;
                z.st = 'wait';
                z.t0 = now;
                z.t1 = now + nxt.wait;
            } else {
                // Финальное сжатие закончено: запускаем отсчёт развязки
                z.st = 'final';
                z.t0 = now;
                z.t1 = now + 99999999;
                if (!state.finalEnd) state.finalEnd = now + CFG.FINAL_STANDOFF_MS;
            }
        }
    }
}

/* ---------------------- PLAYER & CELL LOGIC ---------------------- */
function createCell(p, x, y, mass, vx = 0, vy = 0) {
    return {
        id: nid(),
        pid: p.pid,
        x, y, m: mass,
        vx, vy,
        canMergeAt: T() + mergeTime(mass),
        born: T(),
    };
}

function getPlayerCentroid(p) {
    if (!p.cells.length) return { x: CFG.MAP / 2, y: CFG.MAP / 2, mass: 0 };
    let sx = 0, sy = 0, sm = 0;
    for (const c of p.cells) {
        sx += c.x * c.m; sy += c.y * c.m; sm += c.m;
    }
    return { x: sx / sm, y: sy / sm, mass: sm };
}

function splitPlayer(p) {
    if (state.phase !== 'live' || p.status !== 'alive') return;
    if (T() - p.lastSplit < 120) return;
    p.lastSplit = T();

    const newCells = [];
    for (const c of [...p.cells]) {
        if (p.cells.length + newCells.length >= CFG.MAX_CELLS) break;
        if (c.m < CFG.SPLIT_MIN) continue;

        const half = c.m / 2;
        c.m = half;
        c.canMergeAt = T() + mergeTime(half);

        const len = Math.hypot(p.aim.x, p.aim.y) || 1;
        const dx = p.aim.x / len;
        const dy = p.aim.y / len;

        const child = createCell(p, c.x + dx * radius(half), c.y + dy * radius(half), half, dx * CFG.SPLIT_BOOST, dy * CFG.SPLIT_BOOST);
        newCells.push(child);
    }
    if (newCells.length > 0) {
        p.cells.push(...newCells);
        state.events.push({ type: 'split', x: p.cells[0].x, y: p.cells[0].y, r: radius(p.total) });
    }
}

function ejectMass(p) {
    if (state.phase !== 'live' || p.status !== 'alive') return;
    if (T() - p.lastEject < 60) return;
    p.lastEject = T();

    for (const c of p.cells) {
        if (c.m < CFG.EJECT_MIN) continue;

        c.m -= CFG.EJECT_COST;
        const len = Math.hypot(p.aim.x, p.aim.y) || 1;
        const dx = p.aim.x / len;
        const dy = p.aim.y / len;
        const r = radius(c.m);

        state.ejects.push({
            id: nid(),
            pid: p.pid,
            x: c.x + dx * (r + 10),
            y: c.y + dy * (r + 10),
            m: CFG.EJECT_MASS,
            vx: dx * CFG.EJECT_BOOST,
            vy: dy * CFG.EJECT_BOOST,
            born: T(),
        });
    }
}

function popCellOnVirus(p, cellIdx) {
    const c = p.cells[cellIdx];
    if (!c) return;

    const totalM = c.m;
    const availSlots = CFG.MAX_CELLS - p.cells.length + 1;
    const pieces = Math.min(availSlots, Math.max(2, Math.floor(totalM / 20)));
    const pieceM = totalM / pieces;

    p.cells.splice(cellIdx, 1);

    for (let i = 0; i < pieces; i++) {
        const ang = (i / pieces) * Math.PI * 2 + Math.random() * 0.2;
        const spd = rnd(400, 700);
        p.cells.push(createCell(
            p,
            clamp(c.x + Math.cos(ang) * 10, 20, CFG.MAP - 20),
            clamp(c.y + Math.sin(ang) * 10, 20, CFG.MAP - 20),
            pieceM,
            Math.cos(ang) * spd,
            Math.sin(ang) * spd
        ));
    }
    state.events.push({ type: 'pop', x: c.x, y: c.y, r: radius(totalM) });
}

/* ---------------------- MATCH FLOW & BOT AI ---------------------- */
function updateHost() {
    const allHumans = Array.from(state.players.values()).filter(p => !p.isBot && p.hasJoined);
    if (allHumans.length > 0) {
        if (!allHumans.some(p => p.pid === state.hostPid)) {
            state.hostPid = allHumans[0].pid;
        }
    } else {
        state.hostPid = null;
    }
}

function getAlivePlayers() {
    return Array.from(state.players.values()).filter(p => p.status === 'alive');
}

function updateBots() {
    // Bots completely removed
    return;
}

function startMatch() {
    resetWorld();
    state.phase = 'live';
    state.matchStart = T();
    state.winner = null;

    const participants = Array.from(state.players.values()).filter(p => !p.isBot && p.hasJoined && p.status === 'alive');
    state.startedCount = participants.length;

    // Spawn cells in zone for all human participants
    for (const p of participants) {
        p.status = 'alive';
        p.cells = [];
        p.kills = 0;
        p.total = CFG.START_MASS;
        p.maxMass = CFG.START_MASS;
        p.matchTimeStart = T();
        p.place = 0;
        p.killerName = null;

        const ang = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * (state.zone.r * 0.6);
        const x = clamp(state.zone.x + Math.cos(ang) * r, 100, CFG.MAP - 100);
        const y = clamp(state.zone.y + Math.sin(ang) * r, 100, CFG.MAP - 100);

        p.cells.push(createCell(p, x, y, CFG.START_MASS));
    }

    io.emit('match_start', {
        startedCount: state.startedCount,
        fog: CFG.FOG,
        mapSize: CFG.MAP,
    });
}

function killPlayer(victim, killerName = 'Zone') {
    if (victim.status !== 'alive') return;
    victim.status = 'spectator';
    victim.cells = [];
    victim.killerName = killerName;
    victim.place = getAlivePlayers().length + 1;

    io.emit('kill_feed', {
        killer: killerName,
        victim: victim.name,
        place: victim.place,
        alive: getAlivePlayers().length,
    });

    if (victim.sid) {
        const s = io.sockets.sockets.get(victim.sid);
        if (s) {
            s.emit('eliminated', {
                place: victim.place,
                killer: killerName,
                kills: victim.kills,
                maxMass: Math.round(victim.maxMass),
                you: { place: victim.place, kills: victim.kills, maxMass: Math.round(victim.maxMass), killer: killerName },
            });
        }
    }
    checkMatchEnd();
}

function checkMatchEnd() {
    if (state.phase !== 'live') return;
    const alive = getAlivePlayers();

    if (alive.length === 1 && state.startedCount > 1) {
        endMatch(alive[0]);
    } else if (alive.length === 0) {
        endMatch(null);
    }
}

function endMatch(winner) {
    state.phase = 'over';
    state.matchEnd = T();

    if (winner) {
        winner.place = 1;
        winner.killerName = null;
    }
    state.winner = winner ? { pid: winner.pid, name: winner.name, kills: winner.kills, mass: Math.round(winner.total) } : null;

    // Build final results table: every human that took part in this match
    const participants = Array.from(state.players.values())
        .filter(p => !p.isBot && p.hasJoined && p.matchTimeStart > 0);

    // Players still alive but without a place (e.g. timeout end): rank by current mass
    const aliveNoPlace = participants.filter(p => p.status === 'alive' && (!p.place || p.place === 0));
    aliveNoPlace.sort((a, b) => b.total - a.total);
    let nextPlace = winner ? 2 : 1;
    for (const p of aliveNoPlace) { p.place = nextPlace++; }

    const results = participants
        .map(p => ({
            pid: p.pid,
            name: p.name,
            place: p.place || (winner && p.pid === winner.pid ? 1 : participants.length),
            kills: p.kills,
            maxMass: Math.round(p.maxMass),
            killer: p.killerName,                     // null = survived / won
            survivedSec: Math.max(0, Math.round(((state.matchEnd - p.matchTimeStart) / 1000))),
            isWinner: !!(winner && p.pid === winner.pid),
        }))
        .sort((a, b) => a.place - b.place);

    if (winner && winner.sid) {
        const s = io.sockets.sockets.get(winner.sid);
        if (s) s.emit('victory', { kills: winner.kills, maxMass: Math.round(winner.maxMass), you: { place: 1, kills: winner.kills, maxMass: Math.round(winner.maxMass) } });
    }

    io.emit('match_over', {
        winner: state.winner,
        results: results,
        nextLobbyIn: 10,
    });

    setTimeout(() => {
        state.phase = 'lobby';
        for (const p of state.players.values()) {
            if (!p.isBot) {
                p.status = 'menu';
                p.hasJoined = false;
            }
        }
    }, 10000);
}

/* ---------------------- PHYSICS TICK (30 Hz) ---------------------- */
function physicsTick(dt) {
    state.events = [];
    updateZone();
    updateBots();

    if (state.phase === 'lobby') {
        updateHost();
        // Allow movement for players walking around in lobby, but no eating or zone damage
        for (const p of state.players.values()) {
            if (!p.hasJoined || p.status !== 'alive') continue;
            for (const c of p.cells) {
                const len = Math.hypot(p.aim.x, p.aim.y) || 1;
                const spd = speedOf(c.m);
                c.x += (p.aim.x / len) * spd * dt;
                c.y += (p.aim.y / len) * spd * dt;
                c.x = clamp(c.x, 15, CFG.MAP - 15);
                c.y = clamp(c.y, 15, CFG.MAP - 15);
            }
        }
        // Автостарт отключён: матч начинается только по кнопке хоста (host_start_game).
        return;
    }

    if (state.phase === 'live' && T() - state.matchStart >= CFG.MATCH_MS) {
        const alive = getAlivePlayers().sort((a, b) => b.total - a.total);
        endMatch(alive[0] || null);
        return;
    }

    // Зона сжалась до финального радиуса: после FINAL_STANDOFF_MS побеждает самый массивный
    if (state.phase === 'live' && state.finalEnd > 0 && T() >= state.finalEnd) {
        const alive = getAlivePlayers().sort((a, b) => b.total - a.total);
        endMatch(alive[0] || null);
        return;
    }

    if (state.phase === 'live') {
        checkMatchEnd();
        if (state.phase !== 'live') return;
    }

    if (state.phase !== 'live') return;

    const curZone = getCurrentZone();

    // 1. Update viruses
    for (const v of state.viruses) {
        v.x = clamp(v.x + v.vx * dt, 40, CFG.MAP - 40);
        v.y = clamp(v.y + v.vy * dt, 40, CFG.MAP - 40);
        v.vx *= Math.pow(0.1, dt);
        v.vy *= Math.pow(0.1, dt);
    }

    // 2. Update ejects
    for (let i = state.ejects.length - 1; i >= 0; i--) {
        const e = state.ejects[i];
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        e.vx *= Math.pow(0.05, dt);
        e.vy *= Math.pow(0.05, dt);

        if (e.x < 10 || e.x > CFG.MAP - 10 || e.y < 10 || e.y > CFG.MAP - 10 || (Math.abs(e.vx) < 5 && Math.abs(e.vy) < 5)) {
            e.vx = 0; e.vy = 0;
        }

        // Eject hitting Virus
        for (const v of state.viruses) {
            if (dist(e.x, e.y, v.x, v.y) < radius(v.m)) {
                v.m += e.m * 0.7;
                const len = Math.hypot(e.vx, e.vy) || 1;
                v.vx += (e.vx / len) * 120;
                v.vy += (e.vy / len) * 120;

                state.ejects.splice(i, 1);

                if (v.m >= CFG.VIRUS_MAX) {
                    v.m = CFG.VIRUS_MASS;
                    state.viruses.push({
                        id: nid(),
                        x: v.x, y: v.y,
                        m: CFG.VIRUS_MASS,
                        vx: (e.vx / len) * 600,
                        vy: (e.vy / len) * 600,
                    });
                }
                break;
            }
        }
    }

    // Sort players for top decay rank
    const sortedPlayers = getAlivePlayers().sort((a, b) => b.total - a.total);
    sortedPlayers.forEach((p, idx) => p.rank = idx + 1);

    // 3. Update player cells movement
    for (const p of sortedPlayers) {
        let pTotal = 0;
        const len = Math.hypot(p.aim.x, p.aim.y) || 1;
        const ndx = p.aim.x / len;
        const ndy = p.aim.y / len;

        const cent = getPlayerCentroid(p);

        for (let i = p.cells.length - 1; i >= 0; i--) {
            const c = p.cells[i];

            // Boost decay
            c.x += c.vx * dt;
            c.y += c.vy * dt;
            c.vx *= Math.pow(0.08, dt);
            c.vy *= Math.pow(0.08, dt);

            // Normal movement towards aim
            const spd = speedOf(c.m);
            const targetX = cent.x + p.aim.x;
            const targetY = cent.y + p.aim.y;
            const tDist = dist(c.x, c.y, targetX, targetY);

            if (tDist > 5) {
                const moveRatio = Math.min(1, spd * dt / tDist);
                c.x += (targetX - c.x) * moveRatio;
                c.y += (targetY - c.y) * moveRatio;
            }

            c.x = clamp(c.x, 15, CFG.MAP - 15);
            c.y = clamp(c.y, 15, CFG.MAP - 15);

            // Check Zone damage (урон от токсичной зоны за пределами круга)
            const dToZone = dist(c.x, c.y, curZone.x, curZone.y);
            if (dToZone > curZone.r) {
                const zoneDmg = curZone.dps + c.m * CFG.ZONE_PCT_DPS;
                c.m -= zoneDmg * dt;
            }

            if (c.m < CFG.MIN_MASS) {
                p.cells.splice(i, 1);
                continue;
            }

            pTotal += c.m;
        }

        p.total = pTotal;
        if (p.total > p.maxMass) p.maxMass = p.total;

        if (p.cells.length === 0) {
            killPlayer(p, 'Zone');
        }
    }

    // 4. Same-player cell collisions & merging
    for (const p of getAlivePlayers()) {
        const n = p.cells.length;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const c1 = p.cells[i];
                const c2 = p.cells[j];
                if (!c1 || !c2) continue;

                const d = dist(c1.x, c1.y, c2.x, c2.y);
                const r1 = radius(c1.m), r2 = radius(c2.m);

                if (T() >= c1.canMergeAt && T() >= c2.canMergeAt) {
                    if (d <= r1 + r2 + 15) {
                        c1.m += c2.m;
                        c1.canMergeAt = Math.max(c1.canMergeAt, c2.canMergeAt);
                        p.cells.splice(j, 1);
                        break;
                    }
                } else {
                    // Rigid body push apart
                    const overlap = (r1 + r2) - d;
                    if (overlap > 0 && d > 0.1) {
                        const push = (overlap / d) * 0.5;
                        const px = (c1.x - c2.x) * push;
                        const py = (c1.y - c2.y) * push;
                        c1.x += px; c1.y += py;
                        c2.x -= px; c2.y -= py;
                    }
                }
            }
        }
    }

    // 5. Eating Food
    for (const p of getAlivePlayers()) {
        for (const c of p.cells) {
            const r = radius(c.m);
            for (let i = 0; i < state.food.length; i++) {
                const f = state.food[i];
                if (dist(c.x, c.y, f.x, f.y) < r) {
                    c.m += f.m;
                    spawnFoodAt(i);
                }
            }
        }
    }

    // 6. Eating Ejected Mass
    for (const p of getAlivePlayers()) {
        for (const c of p.cells) {
            const r = radius(c.m);
            for (let i = state.ejects.length - 1; i >= 0; i--) {
                const e = state.ejects[i];
                if (e.pid === p.pid && T() - e.born < 500) continue; // CD for own eject
                if (dist(c.x, c.y, e.x, e.y) < r) {
                    c.m += e.m;
                    state.ejects.splice(i, 1);
                }
            }
        }
    }

    // 7. Virus collisions & popping
    for (const p of getAlivePlayers()) {
        for (let ci = p.cells.length - 1; ci >= 0; ci--) {
            const c = p.cells[ci];
            if (!c) continue;
            const r = radius(c.m);

            for (let vi = state.viruses.length - 1; vi >= 0; vi--) {
                const v = state.viruses[vi];
                const vr = radius(v.m);
                const d = dist(c.x, c.y, v.x, v.y);

                if (d < r && c.m >= CFG.VIRUS_POP_MIN) {
                    state.viruses.splice(vi, 1);
                    popCellOnVirus(p, ci);

                    // Respawn virus
                    state.viruses.push({
                        id: nid(),
                        x: rnd(200, CFG.MAP - 200),
                        y: rnd(200, CFG.MAP - 200),
                        m: CFG.VIRUS_MASS, vx: 0, vy: 0,
                    });
                    break;
                }
            }
        }
    }

    // 8. Player vs Player eating
    const alivePlayers = getAlivePlayers();
    for (let i = 0; i < alivePlayers.length; i++) {
        const p1 = alivePlayers[i];
        for (let j = 0; j < alivePlayers.length; j++) {
            if (i === j) continue;
            const p2 = alivePlayers[j];

            for (let c1i = p1.cells.length - 1; c1i >= 0; c1i--) {
                const c1 = p1.cells[c1i];
                if (!c1) continue;

                for (let c2i = p2.cells.length - 1; c2i >= 0; c2i--) {
                    const c2 = p2.cells[c2i];
                    if (!c2) continue;

                    if (c1.m >= c2.m * CFG.EAT_RATIO) {
                        const r1 = radius(c1.m);
                        const r2 = radius(c2.m);
                        const d = dist(c1.x, c1.y, c2.x, c2.y);

                        if (d < r1 - r2 * CFG.EAT_OVER) {
                            c1.m += c2.m;
                            p2.cells.splice(c2i, 1);
                            state.events.push({ type: 'eat', x: c1.x, y: c1.y, r: r1 });

                            if (p2.cells.length === 0) {
                                p1.kills++;
                                killPlayer(p2, p1.name);
                            }
                            break;
                        }
                    }
                }
            }
        }
    }
}

/* ---------------------- NETWORK BROADCAST (20 Hz) ---------------------- */
function broadcastTick() {
    state.netFrame++;
    const curZone = getCurrentZone();
    const sendFood = (state.netFrame % CFG.FOOD_NET_EVERY === 0);

    const leaderboard = getAlivePlayers()
        .sort((a, b) => b.total - a.total)
        .slice(0, 5)
        .map(p => ({ n: p.name, m: Math.round(p.total) }));

    for (const [sid, socket] of io.sockets.sockets.entries()) {
        const pid = state.bySocket.get(sid);
        const p = state.players.get(pid);

        if (state.phase === 'lobby') {
            updateHost();
            const totalHumans = Array.from(state.players.values()).filter(x => !x.isBot && x.hasJoined).length;
            const joinedHumans = totalHumans;
            const hostPlayer = state.players.get(state.hostPid);
            const isHost = (p && p.pid === state.hostPid);
            socket.emit('lobby_state', {
                phase: 'lobby',
                cd: state.cdEnd ? Math.max(0, Math.ceil((state.cdEnd - T()) / 1000)) : null,
                totalHumans: totalHumans,
                readyCount: joinedHumans,
                isHost: isHost,
                hostName: hostPlayer ? hostPlayer.name : 'Хост',
                minHumans: 2,
            });
            if (!p || !p.hasJoined) continue;
        }

        // Determine viewport center & zoom radius
        let viewX = CFG.MAP / 2, viewY = CFG.MAP / 2, viewR = 1200;
        let myRank = 0, myMass = 0, myKills = 0, status = 'spectator';

        if (p && p.status === 'alive') {
            status = 'alive';
            const c = getPlayerCentroid(p);
            viewX = c.x; viewY = c.y;
            myRank = p.rank; myMass = Math.round(p.total); myKills = p.kills;
            viewR = Math.max(800, radius(p.total) * 12);
        } else if (p && p.status === 'dead' && p.specPid) {
            const specP = state.players.get(p.specPid);
            if (specP && specP.status === 'alive') {
                const c = getPlayerCentroid(specP);
                viewX = c.x; viewY = c.y;
                viewR = 1400;
            }
        }

        // AOI Culling
        const visibleCells = [];
        for (const op of state.players.values()) {
            if (op.status !== 'alive') continue;
            for (const c of op.cells) {
                if (dist(c.x, c.y, viewX, viewY) < viewR + radius(c.m)) {
                    // Compact format: [id, x, y, m, pid, color]
                    visibleCells.push([c.id, Math.round(c.x * 10) / 10, Math.round(c.y * 10) / 10, Math.round(c.m), op.pid, op.color]);
                }
            }
        }

        const visibleViruses = state.viruses
            .filter(v => dist(v.x, v.y, viewX, viewY) < viewR + 100)
            .map(v => [v.id, Math.round(v.x), Math.round(v.y), Math.round(v.m)]);

        const visibleEjects = state.ejects
            .filter(e => dist(e.x, e.y, viewX, viewY) < viewR + 50)
            .map(e => [Math.round(e.x), Math.round(e.y), e.m]);

        let foodArray = null;
        if (sendFood) {
            foodArray = [];
            for (const f of state.food) {
                if (dist(f.x, f.y, viewX, viewY) < viewR + 50) {
                    foodArray.push(f.x, f.y);
                }
            }
        }

        // Roster mapping for names
        const roster = {};
        for (const op of state.players.values()) {
            if (op.status === 'alive') {
                roster[op.pid] = {
                    n: op.name,
                    c: typeof op.color === 'string' ? op.color : null,
                    a: op.avatar || null
                };
            }
        }

        socket.emit('snap', {
            t: T(),
            st: status,
            c: visibleCells,
            v: visibleViruses,
            e: visibleEjects,
            f: foodArray,
            r: roster,
            z: {
                x: Math.round(curZone.x), y: Math.round(curZone.y), r: Math.round(curZone.r),
                nx: state.zone ? Math.round(state.zone.nx) : Math.round(curZone.x),
                ny: state.zone ? Math.round(state.zone.ny) : Math.round(curZone.y),
                nr: state.zone ? Math.round(state.zone.nr) : Math.round(curZone.r),
                st: state.zone ? state.zone.st : 'wait',
                fd: state.finalEnd > 0 ? Math.max(0, Math.ceil((state.finalEnd - T()) / 1000)) : null, // сек. до конца финального противостояния
            },
            hud: { rank: myRank, mass: myMass, kills: myKills, alive: getAlivePlayers().length, time: Math.max(0, Math.floor((CFG.MATCH_MS - (T() - state.matchStart)) / 1000)), lb: leaderboard },
            ev: state.events,
        });
    }
}

/* ---------------------- EXPRESS & SOCKET.IO ---------------------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/avatars', express.static(path.join(__dirname, 'avatars')));
app.use('/avatars', express.static(path.join(__dirname, 'public/avatars')));

io.on('connection', (socket) => {
    let player = newPlayer(socket.id, 'Player');
    state.players.set(player.pid, player);
    state.bySocket.set(socket.id, player.pid);

    socket.emit('welcome', { pid: player.pid, mapSize: CFG.MAP, fog: CFG.FOG });

    socket.on('join', (data) => {
        player.name = sanitizeName(data && data.name);
        if (data && typeof data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.color)) {
            player.color = data.color;
        }
        if (data && typeof data.avatar === 'string' && data.avatar.trim().length > 0) {
            const trimmed = data.avatar.trim();
            player.avatar = trimmed.startsWith('data:image/') ? trimmed.slice(0, 200000) : trimmed.slice(0, 500);
        } else {
            player.avatar = null;
        }
        player.hasJoined = true;
        if (state.phase === 'live') {
            player.status = 'spectator';
            socket.emit('joined_spectator');
        } else {
            player.status = 'alive';
            player.cells = [];
            player.kills = 0;
            player.total = CFG.START_MASS;
            player.maxMass = CFG.START_MASS;
            const curZone = getCurrentZone();
            const ang = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * (curZone.r * 0.5);
            const x = clamp(curZone.x + Math.cos(ang) * r, 100, CFG.MAP - 100);
            const y = clamp(curZone.y + Math.sin(ang) * r, 100, CFG.MAP - 100);
            player.cells.push(createCell(player, x, y, CFG.START_MASS));
            updateHost();
            socket.emit('joined_lobby');
        }
    });

    socket.on('host_start_game', () => {
        updateHost();
        if (player.pid !== state.hostPid) {
            socket.emit('admin_error', 'Только первый игрок (организатор) может начать игру!');
            return;
        }
        const joinedHumans = Array.from(state.players.values()).filter(x => !x.isBot && x.hasJoined).length;
        if (joinedHumans < 2) {
            socket.emit('admin_error', 'Нужно минимум 2 игрока для старта!');
            return;
        }
        state.cdEnd = 0;
        startMatch();
    });

    socket.on('aim', (data) => {
        if (data && typeof data.x === 'number' && typeof data.y === 'number') {
            player.aim = { x: clamp(data.x, -2000, 2000), y: clamp(data.y, -2000, 2000) };
        }
    });

    socket.on('split', () => splitPlayer(player));
    socket.on('eject', () => ejectMass(player));

    socket.on('update_settings', (data) => {
        if (!data || data.adminKey !== CFG.ADMIN_KEY) {
            socket.emit('admin_error', 'Неверный пароль администратора!');
            return;
        }
        if (state.phase === 'lobby' && data) {
            if (typeof data.botFill === 'number') CFG.BOT_FILL = clamp(data.botFill, 0, 60);
            if (typeof data.startMass === 'number') CFG.START_MASS = clamp(data.startMass, 10, 500);
            if (typeof data.foodCount === 'number') CFG.FOOD = clamp(data.foodCount, 200, 3000);
            if (typeof data.virusCount === 'number') CFG.VIRUS = clamp(data.virusCount, 4, 80);
            if (typeof data.matchMin === 'number') CFG.MATCH_MS = clamp(data.matchMin, 1, 30) * 60 * 1000;
            if (typeof data.zoneWait === 'number' || typeof data.zoneDuration === 'number') {
                const w = clamp(data.zoneWait || 5, 0, 60) * 1000;
                const d = clamp(data.zoneDuration || 15, 5, 120) * 1000;
                const dpsMult = clamp(data.zoneDps || 3, 1, 50);
                CFG.ZONE_PHASES = [
                    { wait: w, shrink: d, r: 2400, dps: dpsMult },
                    { wait: Math.round(w * 0.4), shrink: d, r: 1500, dps: Math.round(dpsMult * 2.5) },
                    { wait: Math.round(w * 0.2), shrink: d, r: 750, dps: Math.round(dpsMult * 5) },
                    { wait: 0, shrink: d, r: 180, dps: Math.round(dpsMult * 10) }
                ];
            }
            io.emit('settings_updated', {
                botFill: CFG.BOT_FILL,
                startMass: CFG.START_MASS,
                foodCount: CFG.FOOD,
                virusCount: CFG.VIRUS,
                matchMs: CFG.MATCH_MS,
                zonePhases: CFG.ZONE_PHASES
            });
        }
    });

    socket.on('spec_target', (dir) => {
        const alive = getAlivePlayers();
        if (!alive.length) return;
        let idx = alive.findIndex(a => a.pid === player.specPid);
        if (dir === 'next') idx = (idx + 1) % alive.length;
        else idx = (idx - 1 + alive.length) % alive.length;
        player.specPid = alive[idx].pid;
    });

    socket.on('disconnect', () => {
        if (state.phase === 'live' && player.status === 'alive') killPlayer(player, 'Disconnected');
        state.players.delete(player.pid);
        state.bySocket.delete(socket.id);
        updateHost();
    });
});

/* ---------------------- ENGINE LOOPS ---------------------- */
let lastSim = T();
setInterval(() => {
    const now = T();
    const dt = Math.min(0.1, (now - lastSim) / 1000);
    lastSim = now;
    physicsTick(dt);
}, 1000 / CFG.SIM_HZ);

setInterval(() => {
    broadcastTick();
}, 1000 / CFG.NET_HZ);

server.listen(CFG.PORT, () => {
    console.log(`====================================================`);
    console.log(` CELL ROYALE Server running on http://localhost:${CFG.PORT}`);
    console.log(` MAP: ${CFG.MAP}x${CFG.MAP} | FOG: ${CFG.FOG} | BOTS: ${CFG.BOT_FILL}`);
    console.log(`====================================================`);
});