'use strict';
/* ============================================================
   CELL ROYALE — Canvas 2D Client & Rendering Pipeline
   ============================================================ */

const socket = io();

/* ---------------------- COLOR PALETTE ---------------------- */
const PALETTE = [
    '#ff0055', '#00f0ff', '#00ff66', '#ffcc00', '#cc00ff',
    '#ff6600', '#0099ff', '#ff00aa', '#00ffcc', '#ff3333'
];

/* ---------------------- STATE & VARS ---------------------- */
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const mmCanvas = document.getElementById('minimap');
const mmCtx = mmCanvas.getContext('2d');

let mapSize = 4000;
let myPid = null;
let snapshots = [];
let localFood = new Map(); // "x,y" -> {x, y}
let renderPos = { x: 2000, y: 2000 };
let currentZoom = 1;
let dangerIntensity = 0;

// UI elements
const screenJoin = document.getElementById('screen-join');
const screenLobby = document.getElementById('screen-lobby');
const screenEnd = document.getElementById('screen-end');
const hud = document.getElementById('hud');
const inputName = document.getElementById('input-name');
const btnPlay = document.getElementById('btn-play');
const btnAgain = document.getElementById('btn-again');

const valMass = document.getElementById('val-mass');
const valRank = document.getElementById('val-rank');
const valAlive = document.getElementById('val-alive');
const valKills = document.getElementById('val-kills');
const valTime = document.getElementById('val-time');
const lbList = document.getElementById('lb-list');
const killfeed = document.getElementById('killfeed');
const dangerVignette = document.getElementById('danger-vignette');

const specBar = document.getElementById('spec-bar');
const specName = document.getElementById('spec-name');
const btnPrevSpec = document.getElementById('btn-prev-spec');
const btnNextSpec = document.getElementById('btn-next-spec');

/* ---------------------- CANVAS RESIZE ---------------------- */
function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
}
window.addEventListener('resize', resize);
resize();

/* ---------------------- INPUT HANDLING ---------------------- */
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;

window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    sendAim();
});

function sendAim() {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    socket.emit('aim', { x: (mouseX - cx) / currentZoom, y: (mouseY - cy) / currentZoom });
}

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') socket.emit('split');
    if (e.code === 'KeyW') socket.emit('eject');
});

btnPlay.addEventListener('click', () => {
    socket.emit('join', { name: inputName.value });
    screenJoin.classList.add('hidden');
});

btnAgain.addEventListener('click', () => {
    screenEnd.classList.add('hidden');
    screenJoin.classList.remove('hidden');
});

btnPrevSpec.addEventListener('click', () => socket.emit('spec_target', 'prev'));
btnNextSpec.addEventListener('click', () => socket.emit('spec_target', 'next'));

/* ---------------------- SOCKET EVENTS ---------------------- */
socket.on('welcome', (data) => {
    myPid = data.pid;
    mapSize = data.mapSize;
});

socket.on('joined_lobby', () => {
    screenLobby.classList.remove('hidden');
    hud.classList.add('hidden');
});

socket.on('joined_spectator', () => {
    hud.classList.remove('hidden');
    specBar.classList.remove('hidden');
});

socket.on('lobby_state', (data) => {
    document.getElementById('lobby-status').innerText = data.cd ? `Game starting in...` : `Waiting for players...`;
    document.getElementById('lobby-timer').innerText = data.cd ? `${data.cd}s` : `--`;
    document.getElementById('lobby-players-count').innerText = `Players: ${data.players.length} / Fill: ${data.botCount}`;
});

socket.on('match_start', () => {
    screenLobby.classList.add('hidden');
    screenEnd.classList.add('hidden');
    hud.classList.remove('hidden');
    specBar.classList.add('hidden');
    snapshots = [];
});

socket.on('snap', (snap) => {
    snapshots.push(snap);
    if (snapshots.length > 15) snapshots.shift();

    // Cache food delta
    if (snap.f) {
        localFood.clear();
        for (let i = 0; i < snap.f.length; i += 2) {
            localFood.set(`${snap.f[i]},${snap.f[i + 1]}`, { x: snap.f[i], y: snap.f[i + 1] });
        }
    }

    // Update HUD
    if (snap.hud) {
        valMass.innerText = snap.hud.mass;
        valRank.innerText = snap.hud.rank ? `#${snap.hud.rank}` : '-';
        valAlive.innerText = snap.hud.alive;
        valKills.innerText = snap.hud.kills;

        const m = Math.floor(snap.hud.time / 60);
        const s = snap.hud.time % 60;
        valTime.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

        lbList.innerHTML = snap.hud.lb.map((p, i) => `
      <div class="lb-row ${p.n === inputName.value ? 'me' : ''}">
        <span>${i + 1}. ${p.n}</span>
        <span>${p.m}</span>
      </div>
    `).join('');
    }
});

socket.on('kill_feed', (data) => {
    const item = document.createElement('div');
    item.className = 'kf-item';
    item.innerHTML = `<b>${data.killer}</b> ate <b>${data.victim}</b> (#${data.place})`;
    killfeed.appendChild(item);
    setTimeout(() => item.remove(), 4000);
});

socket.on('eliminated', (data) => {
    screenEnd.classList.remove('hidden');
    document.getElementById('end-title').innerText = 'ELIMINATED';
    document.getElementById('end-title').style.color = '#ff0055';
    document.getElementById('end-sub').innerText = `Placement: #${data.place}`;
    document.getElementById('end-kills').innerText = data.kills;
    document.getElementById('end-mass').innerText = data.maxMass;
    document.getElementById('end-killer').innerText = data.killer;
    specBar.classList.remove('hidden');
});

socket.on('victory', (data) => {
    screenEnd.classList.remove('hidden');
    document.getElementById('end-title').innerText = 'VICTORY ROYALE!';
    document.getElementById('end-title').style.color = '#00f0ff';
    document.getElementById('end-sub').innerText = `Winner #1`;
    document.getElementById('end-kills').innerText = data.kills;
    document.getElementById('end-mass').innerText = data.maxMass;
    document.getElementById('end-killer').innerText = 'None';
});

/* ---------------------- INTERPOLATION & RENDERING ---------------------- */
function getInterpolatedSnapshot() {
    if (snapshots.length === 0) return null;
    if (snapshots.length === 1) return snapshots[0];

    const renderTime = Date.now() - 100; // 100ms render buffer
    let s0 = snapshots[0], s1 = snapshots[1];

    for (let i = 0; i < snapshots.length - 1; i++) {
        if (snapshots[i].t <= renderTime && renderTime <= snapshots[i + 1].t) {
            s0 = snapshots[i];
            s1 = snapshots[i + 1];
            break;
        }
    }

    const factor = Math.max(0, Math.min(1, (renderTime - s0.t) / (s1.t - s0.t || 1)));

    // Lerp cells
    const interpolatedCells = [];
    const cMap = new Map();
    s1.c.forEach(c => cMap.set(c[0], c));

    s0.c.forEach(c0 => {
        const c1 = cMap.get(c0[0]);
        if (c1) {
            interpolatedCells.push([
                c0[0],
                c0[1] + (c1[1] - c0[1]) * factor,
                c0[2] + (c1[2] - c0[2]) * factor,
                c0[3] + (c1[3] - c0[3]) * factor,
                c0[4],
                c0[5]
            ]);
            cMap.delete(c0[0]);
        } else {
            interpolatedCells.push(c0);
        }
    });
    cMap.forEach(c1 => interpolatedCells.push(c1));

    return {
        cells: interpolatedCells,
        viruses: s1.v,
        ejects: s1.e,
        roster: s1.r,
        zone: s1.z,
        st: s1.st,
    };
}

function render() {
    requestAnimationFrame(render);

    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const snap = getInterpolatedSnapshot();
    if (!snap) return;

    // Find camera position
    let myCells = snap.cells.filter(c => c[4] === myPid);
    if (myCells.length > 0) {
        let sx = 0, sy = 0, sm = 0;
        myCells.forEach(c => { sx += c[1] * c[3]; sy += c[2] * c[3]; sm += c[3]; });
        renderPos.x += (sx / sm - renderPos.x) * 0.25;
        renderPos.y += (sy / sm - renderPos.y) * 0.25;
        const targetZoom = Math.max(0.25, Math.min(1.2, 1000 / (1000 + Math.sqrt(sm) * 20)));
        currentZoom += (targetZoom - currentZoom) * 0.1;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // Camera transform
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    ctx.translate(cx, cy);
    ctx.scale(currentZoom, currentZoom);
    ctx.translate(-renderPos.x, -renderPos.y);

    // 1. Draw Grid Background
    drawGrid();

    // 2. Draw Zone
    drawZone(snap.zone);

    // 3. Draw Food
    ctx.fillStyle = '#00f0ff';
    localFood.forEach(f => {
        ctx.beginPath();
        ctx.arc(f.x, f.y, 4, 0, Math.PI * 2);
        ctx.fill();
    });

    // 4. Draw Ejected Mass
    snap.ejects.forEach(e => {
        ctx.fillStyle = '#ffcc00';
        ctx.beginPath();
        ctx.arc(e[0], e[1], Math.sqrt(e[2]) * 2.5, 0, Math.PI * 2);
        ctx.fill();
    });

    // 5. Draw Viruses
    snap.viruses.forEach(v => {
        drawVirus(v[1], v[2], 4 * Math.sqrt(v[3]));
    });

    // 6. Draw Player Cells
    snap.cells.forEach(c => {
        const [id, x, y, mass, pid, colIdx] = c;
        const r = 4 * Math.sqrt(mass);
        const color = PALETTE[colIdx % PALETTE.length];
        const name = snap.roster[pid] || '';

        ctx.fillStyle = color;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = pid === myPid ? 4 : 2;

        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Text label
        if (r > 12) {
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.max(10, r * 0.3)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(name, x, y - (r > 20 ? 6 : 0));

            if (r > 20) {
                ctx.font = `${Math.max(8, r * 0.22)}px sans-serif`;
                ctx.fillText(Math.round(mass), x, y + r * 0.25);
            }
        }
    });

    ctx.restore();

    // Render Minimap
    drawMinimap(snap.zone);

    // Danger Vignette Update
    const dToZoneCenter = Math.hypot(renderPos.x - snap.zone.x, renderPos.y - snap.zone.y);
    if (dToZoneCenter > snap.zone.r) {
        dangerIntensity = Math.min(1, dangerIntensity + 0.05);
    } else {
        dangerIntensity = Math.max(0, dangerIntensity - 0.05);
    }
    dangerVignette.style.opacity = dangerIntensity;
}

function drawGrid() {
    const gridSize = 100;
    ctx.strokeStyle = '#181c30';
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let x = 0; x <= mapSize; x += gridSize) {
        ctx.moveTo(x, 0); ctx.lineTo(x, mapSize);
    }
    for (let y = 0; y <= mapSize; y += gridSize) {
        ctx.moveTo(0, y); ctx.lineTo(mapSize, y);
    }
    ctx.stroke();

    // World Bounds
    ctx.strokeStyle = '#ff0055';
    ctx.lineWidth = 8;
    ctx.strokeRect(0, 0, mapSize, mapSize);
}

function drawZone(z) {
    // Safe zone circle
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 4;
    ctx.setLineDash([15, 10]);
    ctx.beginPath();
    ctx.arc(z.nx, z.ny, z.nr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Current shrinking zone circle
    ctx.strokeStyle = '#ff0055';
    ctx.lineWidth = 6;
    ctx.shadowColor = '#ff0055';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
}

function drawVirus(x, y, r) {
    ctx.fillStyle = '#33ff33';
    ctx.strokeStyle = '#22aa22';
    ctx.lineWidth = 4;

    const spikes = 16;
    ctx.beginPath();
    for (let i = 0; i < spikes; i++) {
        const angle = (i / spikes) * Math.PI * 2;
        const dist = i % 2 === 0 ? r + 6 : r - 2;
        const vx = x + Math.cos(angle) * dist;
        const vy = y + Math.sin(angle) * dist;
        if (i === 0) ctx.moveTo(vx, vy);
        else ctx.lineTo(vx, vy);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
}

function drawMinimap(z) {
    mmCtx.clearRect(0, 0, 160, 160);
    const scale = 160 / mapSize;

    // Zone preview
    mmCtx.strokeStyle = '#ff0055';
    mmCtx.lineWidth = 2;
    mmCtx.beginPath();
    mmCtx.arc(z.x * scale, z.y * scale, z.r * scale, 0, Math.PI * 2);
    mmCtx.stroke();

    // Player position dot
    mmCtx.fillStyle = '#00f0ff';
    mmCtx.beginPath();
    mmCtx.arc(renderPos.x * scale, renderPos.y * scale, 3, 0, Math.PI * 2);
    mmCtx.fill();
}

// Start rendering engine
requestAnimationFrame(render);