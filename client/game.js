/* ═══════════════════════════════════════════════════════════════════════════
   TIME BOMB ARENA — Client
   game.js
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ─── SOCKET ──────────────────────────────────────────────────────────────────
function resolveSocketServerUrl() {
  const params = new URLSearchParams(window.location.search);
  const queryServer = normalizeServerUrl(params.get('server'));
  const storedServer = normalizeServerUrl(window.localStorage.getItem('timeBombServerUrl'));
  const configuredServer = normalizeServerUrl(window.TIME_BOMB_SERVER_URL);

  if (queryServer) {
    window.localStorage.setItem('timeBombServerUrl', queryServer);
    return queryServer;
  }

  // Prefer the deployment-configured backend so old localStorage values
  // do not silently point different players at different Socket.IO servers.
  if (configuredServer) {
    if (storedServer && storedServer !== configuredServer) {
      window.localStorage.setItem('timeBombServerUrl', configuredServer);
    }
    return configuredServer;
  }

  return storedServer || window.location.origin;
}

let socket = null;
let currentServerUrl = '';

function setConnectionStatus(message, state = 'default') {
  const el = document.getElementById('connection-status');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('is-connected', 'is-error');
  if (state === 'connected') el.classList.add('is-connected');
  if (state === 'error') el.classList.add('is-error');
}

function normalizeServerUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';

  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch (_error) {
    return '';
  }
}

function connectSocket(serverUrl) {
  const resolvedUrl = normalizeServerUrl(serverUrl) || window.location.origin;

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }

  currentServerUrl = resolvedUrl;
  window.localStorage.setItem('timeBombServerUrl', resolvedUrl);
  setConnectionStatus('Connecting to server...');

  socket = io(resolvedUrl, {
    transports: ['websocket'],
    autoConnect: true,
  });

  registerSocketEvents();
  return socket;
}

// ─── STATE ───────────────────────────────────────────────────────────────────
let myPlayerId   = null;
let myRoomId     = null;
let currentHostId = null;
let currentPhase = 'lobby';   // lobby | waiting | playing | gameover
let gameScene    = null;       // reference to Phaser scene
let mapData      = null;
let localScores  = {};
let latestRoomPlayers = [];
const SPAWN_PREVIEW_POSITIONS = [
  { x: 100, y: 300 }, { x: 800, y: 300 },
  { x: 450, y: 80  }, { x: 450, y: 520 },
  { x: 100, y: 100 }, { x: 800, y: 500 },
];
const CHARACTER_OPTIONS = [
  {
    id: 'forest-ranger-1',
    textureKey: 'character-forest-ranger-1',
    avatarUrl: '/characters/Forest_Ranger_1/PNG/PNG%20Sequences/Idle/0_Forest_Ranger_Idle_000.png',
  },
  {
    id: 'forest-ranger-2',
    textureKey: 'character-forest-ranger-2',
    avatarUrl: '/characters/Forest_Ranger_2/PNG/PNG%20Sequences/Idle/0_Forest_Ranger_Idle_000.png',
  },
  {
    id: 'forest-ranger-3',
    textureKey: 'character-forest-ranger-3',
    avatarUrl: '/characters/Forest_Ranger_3/PNG/PNG%20Sequences/Idle/0_Forest_Ranger_Idle_000.png',
  },
];
// ─── SCREEN HELPERS ──────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function showTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.getElementById(`panel-${tab}`).classList.add('active');
}

function setError(msg) {
  const el = document.getElementById('lobby-error');
  if (el) { el.textContent = msg; }
}

function setWaitingMessage(msg) {
  const el = document.getElementById('waiting-message');
  if (el) {
    el.textContent = msg || '';
  }
}

// ─── LOBBY ACTIONS ───────────────────────────────────────────────────────────
function createRoom() {
  const name = document.getElementById('input-name').value.trim() || 'Bomber';
  ensureSocketConnection();
  if (!socket.connected) {
    setError('Server is not connected yet. Please try again in a moment.');
    return;
  }
  socket.emit('createRoom', { name });
}

function joinRoom() {
  const name   = document.getElementById('input-name').value.trim() || 'Bomber';
  const roomId = document.getElementById('input-room').value.trim().toUpperCase();
  if (!roomId) { setError('Enter a room code'); return; }
  ensureSocketConnection();
  if (!socket.connected) {
    setError('Server is not connected yet. Please try again in a moment.');
    return;
  }
  socket.emit('joinRoom', { roomId, name });
}

function startGame() { socket.emit('startGame'); }

function playAgain() { socket.emit('playAgain'); }

function goToLobby() { location.reload(); }

// ─── WAITING ROOM ────────────────────────────────────────────────────────────
function renderWaitingRoom(players) {
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player-entry';
    div.innerHTML = `
      <div class="player-avatar-wrap">
        <img class="player-avatar" src="${escapeAttribute(getPlayerAvatarUrl(p))}" alt="${escapeAttribute(p.name)}" />
      </div>
      <span class="player-entry-name">${escapeHtml(p.name)}</span>
      ${p.id === currentHostId ? '<span class="player-entry-badge">HOST</span>' : ''}
    `;
    list.appendChild(div);
  });
}

function updateWaitingControls(players = []) {
  const startBtn = document.getElementById('btn-start');
  const hint = document.getElementById('waiting-hint');
  const playerCount = players.length;
  const canStart = myPlayerId === currentHostId;

  if (startBtn) {
    startBtn.disabled = !canStart || playerCount < 2;
    startBtn.textContent = canStart ? 'Start Game' : 'Host Controls Start';
  }

  if (hint) {
    if (playerCount < 2) {
      hint.textContent = `Need at least 2 players (${playerCount}/2 joined)`;
    } else if (canStart) {
      hint.textContent = 'Everyone is in. Start when ready.';
    } else {
      hint.textContent = 'Waiting for the host to start the game';
    }
  }
}

function applyRoomState(data) {
  if (!data) return;
  currentHostId = data.hostId || null;
  if (data.roomId) {
    myRoomId = data.roomId;
    const roomCodeEl = document.getElementById('display-room-code');
    if (roomCodeEl) roomCodeEl.textContent = data.roomId;
  }
  if (Array.isArray(data.players)) {
    latestRoomPlayers = data.players.map((player) => ({ ...player }));
    renderWaitingRoom(data.players);
    updateWaitingControls(data.players);
  }
}

function buildPreviewGameState(firstBombHolder = null) {
  const previewSpawns = Array.isArray(mapData?.spawns) && mapData.spawns.length
    ? mapData.spawns
    : SPAWN_PREVIEW_POSITIONS;
  return {
    players: latestRoomPlayers.map((player, index) => {
      const spawn = previewSpawns[index % previewSpawns.length];
      return {
        id: player.id,
        name: player.name,
        x: spawn.x,
        y: spawn.y,
        alive: true,
        hasBomb: player.id === firstBombHolder,
        dashActive: false,
        color: player.color,
        characterId: player.characterId,
        avatarUrl: player.avatarUrl,
      };
    }),
    bombTimer: BOMB_TIMER_MS,
    bombHolder: firstBombHolder,
  };
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escapeAttribute(s) {
  return escapeHtml(String(s)).replace(/"/g, '&quot;');
}

function getCharacterOption(characterId) {
  return CHARACTER_OPTIONS.find((option) => option.id === characterId) || CHARACTER_OPTIONS[0];
}

function getCharacterTextureKey(characterId) {
  return getCharacterOption(characterId).textureKey;
}

function getPlayerAvatarUrl(player) {
  if (player && player.avatarUrl) return player.avatarUrl;
  return getCharacterOption(player?.characterId).avatarUrl;
}

function renderAvatarMarkup(player, className = 'score-avatar') {
  return `<img class="${className}" src="${escapeAttribute(getPlayerAvatarUrl(player))}" alt="${escapeAttribute(player?.name || 'Player')}" />`;
}

function getThemePalette(themeId) {
  const palettes = {
    'neon-city': {
      background: 0x070b16,
      floor: 0x121a2d,
      grid: 0x233251,
      wall: 0x34415f,
      wallEdge: 0x85a4df,
      wallTop: 0x5afff6,
      border: 0xff4fd8,
      accent: 0x42efff,
      accent2: 0xff4fd8,
      accent3: 0xffcf4a,
      shadow: 0x05070d,
    },
    lava: {
      background: 0x170805,
      floor: 0x2a1610,
      grid: 0x4f2819,
      wall: 0x66443b,
      wallEdge: 0xd78a63,
      wallTop: 0xffbe73,
      border: 0xff6a00,
      accent: 0xff5a1f,
      accent2: 0xffbf00,
      accent3: 0xffd166,
      shadow: 0x090303,
    },
    ice: {
      background: 0x081521,
      floor: 0xdceefb,
      grid: 0xbcd8ef,
      wall: 0x77b7e8,
      wallEdge: 0xf4fbff,
      wallTop: 0xffffff,
      border: 0x8ddcff,
      accent: 0x27d3ff,
      accent2: 0x7af6ff,
      accent3: 0x5aa7ff,
      shadow: 0x0a1c2f,
    },
    ruins: {
      background: 0x18170d,
      floor: 0x595133,
      grid: 0x776c43,
      wall: 0x9a8b61,
      wallEdge: 0xd7c88f,
      wallTop: 0xe9dda9,
      border: 0x9be24f,
      accent: 0xa3ff6a,
      accent2: 0x7fc941,
      accent3: 0xd5b56f,
      shadow: 0x0f1008,
    },
    'space-station': {
      background: 0x0b0f17,
      floor: 0x242a36,
      grid: 0x3a4354,
      wall: 0x5a6372,
      wallEdge: 0xc5d0e2,
      wallTop: 0x8cebff,
      border: 0x8d97ab,
      accent: 0x57d8ff,
      accent2: 0x8471ff,
      accent3: 0xffc83d,
      shadow: 0x05070b,
    },
    desert: {
      background: 0x2b2112,
      floor: 0xd8ba73,
      grid: 0xc5a45d,
      wall: 0xb79761,
      wallEdge: 0xf0d89b,
      wallTop: 0xfff0ba,
      border: 0xe0c15a,
      accent: 0xffd76c,
      accent2: 0xc6922a,
      accent3: 0xa8d25f,
      shadow: 0x1a1209,
    },
    haunted: {
      background: 0x130d1c,
      floor: 0x33243e,
      grid: 0x493558,
      wall: 0x5b4c67,
      wallEdge: 0xb8a9c9,
      wallTop: 0xeadcff,
      border: 0xb15dff,
      accent: 0xc56cff,
      accent2: 0x7f4bff,
      accent3: 0xffa3d8,
      shadow: 0x09060d,
    },
    jungle: {
      background: 0x0a1708,
      floor: 0x4f4528,
      grid: 0x665a34,
      wall: 0x8c8359,
      wallEdge: 0xd4cb9a,
      wallTop: 0xebdeab,
      border: 0x6ae35b,
      accent: 0x9cff76,
      accent2: 0x57bf44,
      accent3: 0xc0a05b,
      shadow: 0x061005,
    },
    forest: {
      background: 0x08110b,
      floor: 0x102016,
      grid: 0x1a3625,
      wall: 0x2c4f35,
      wallEdge: 0x5d8664,
      wallTop: 0x88b38d,
      border: 0x35563b,
      accent: 0x7ad372,
      accent2: 0x4cae5d,
      accent3: 0xa2d59b,
      shadow: 0x050906,
    },
    industrial: {
      background: 0x0a0d12,
      floor: 0x171c24,
      grid: 0x242d38,
      wall: 0x495362,
      wallEdge: 0x8f99a9,
      wallTop: 0xb8c0cc,
      border: 0x5f6979,
      accent: 0x66d1ff,
      accent2: 0x8d84ff,
      accent3: 0xffc746,
      shadow: 0x05070b,
    },
  };
  return palettes[themeId] || palettes.forest;
}

function getArenaPolygon(inset = 24, cornerCut = 60) {
  return [
    inset + cornerCut, inset,
    MAP_W - inset - cornerCut, inset,
    MAP_W - inset, inset + cornerCut,
    MAP_W - inset, MAP_H - inset - cornerCut,
    MAP_W - inset - cornerCut, MAP_H - inset,
    inset + cornerCut, MAP_H - inset,
    inset, MAP_H - inset - cornerCut,
    inset, inset + cornerCut,
  ];
}

function drawPolygon(g, points, fillColor, fillAlpha = 1, strokeColor = null, strokeWidth = 0, strokeAlpha = 1) {
  g.fillStyle(fillColor, fillAlpha);
  g.beginPath();
  g.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) {
    g.lineTo(points[i], points[i + 1]);
  }
  g.closePath();
  g.fillPath();

  if (strokeColor !== null && strokeWidth > 0) {
    g.lineStyle(strokeWidth, strokeColor, strokeAlpha);
    g.strokePoints(pointsToPhaser(points), true);
  }
}

function pointsToPhaser(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 2) {
    out.push(new Phaser.Geom.Point(points[i], points[i + 1]));
  }
  return out;
}

// ─── HUD ─────────────────────────────────────────────────────────────────────
function updateHUD(state) {
  const timerEl   = document.getElementById('bomb-timer-text');
  const barEl     = document.getElementById('bomb-timer-bar');
  const boardEl   = document.getElementById('score-board');

  const pct = Math.max(0, state.bombTimer / BOMB_TIMER_MS);
  barEl.style.width = (pct * 100) + '%';

  const secs = (state.bombTimer / 1000).toFixed(1);
  timerEl.textContent = secs + 's';
  timerEl.classList.toggle('danger', state.bombTimer < 10000);

  // Score board
  boardEl.innerHTML = '';
  (state.players || []).forEach(p => {
    const div = document.createElement('div');
    div.className = 'score-entry' +
      (p.hasBomb ? ' has-bomb' : '') +
      (!p.alive  ? ' eliminated' : '');
    div.innerHTML = `
      ${renderAvatarMarkup(p, 'score-avatar')}
      <span>${escapeHtml(p.name)}</span>
      <span style="color:var(--accent2);margin-left:4px">${localScores[p.id] || 0}</span>
      ${p.hasBomb ? ' 💣' : ''}
    `;
    boardEl.appendChild(div);
  });
}

function showGameMessage(msg, duration = 2500) {
  const el = document.getElementById('game-message');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showGameMessage._t);
  showGameMessage._t = setTimeout(() => el.classList.add('hidden'), duration);
}

function triggerScreenShake() {
  const canvas = document.getElementById('game-canvas-wrap');
  canvas.classList.remove('shaking');
  void canvas.offsetWidth; // reflow
  canvas.classList.add('shaking');
}

// ─── AUDIO (Web Audio API) ───────────────────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTick(speed = 1) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.value = 220 + speed * 80;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.05);
  } catch(e){}
}

function playExplosion() {
  try {
    const ctx = getAudioCtx();
    const bufSize = ctx.sampleRate * 0.6;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufSize, 1.5);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    src.connect(gain); gain.connect(ctx.destination);
    src.start();

    // Low thud
    const osc = ctx.createOscillator();
    const og  = ctx.createGain();
    osc.connect(og); og.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = 80;
    og.gain.setValueAtTime(0.7, ctx.currentTime);
    og.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(); osc.stop(ctx.currentTime + 0.5);
  } catch(e){}
}

function playBombTransfer() {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sawtooth'; osc.frequency.value = 440;
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start(); osc.stop(ctx.currentTime + 0.12);
  } catch(e){}
}

function playTeleport() {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'triangle';
    osc.frequency.value = 260;
    osc.frequency.exponentialRampToValueAtTime(820, ctx.currentTime + 0.16);
    gain.gain.setValueAtTime(0.09, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.start(); osc.stop(ctx.currentTime + 0.18);
  } catch(e){}
}

// ─── PHASER GAME ─────────────────────────────────────────────────────────────
const PLAYER_RADIUS = 18;
const MAP_W = 900, MAP_H = 600;
const BOMB_TIMER_MS = 60000;

class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
    this.players    = {};   // id -> graphics + data
    this.bombHolder = null;
    this.bombTimer  = BOMB_TIMER_MS;
    this.lastTickSound = 0;
    this.particles  = [];
    this.portals    = [];
    this.walls      = [];
    this.movingWallSprites = {};
    this.rotatingBarSprites = {};
    this.activeEventOverlay = null;
    this.themeId = 'forest';
    this.mapId = 'forest';
  }

  preload() {
    for (const option of CHARACTER_OPTIONS) {
      if (!this.textures.exists(option.textureKey)) {
        this.load.image(option.textureKey, option.avatarUrl);
      }
    }
  }

  create() {
    gameScene = this;
    this.cameras.main.setBackgroundColor('#080b12');

    // Build map if we have it
    if (mapData) this.buildMap(mapData);

    // Particle emitter (manual)
    this.particleGraphics = this.add.graphics();

    if ((currentPhase === 'countdown' || currentPhase === 'playing') && latestRoomPlayers.length) {
      this.updateFromState(buildPreviewGameState());
    }
  }

  prepareForRound(firstBombHolder = null) {
    for (const id of Object.keys(this.players)) {
      this.destroyPlayer(id);
    }
    this.players = {};
    this.particles = [];
    if (this.particleGraphics) {
      this.particleGraphics.clear();
    }
    if (latestRoomPlayers.length) {
      this.updateFromState(buildPreviewGameState(firstBombHolder));
    }
  }

  buildMap(data) {
    this.themeId = data?.theme?.visualId || data?.theme?.id || 'forest';
    this.mapId = data?.id || this.themeId;
    if (this.mapGfx) this.mapGfx.destroy();
    this.portals.forEach((portal) => {
      portal.container.destroy();
    });
    Object.values(this.movingWallSprites).forEach((wall) => {
      wall.gfx.destroy();
    });
    Object.values(this.rotatingBarSprites).forEach((bar) => {
      bar.gfx.destroy();
    });
    if (this.activeEventOverlay) {
      this.activeEventOverlay.destroy();
      this.activeEventOverlay = null;
    }
    this.portals = [];
    this.movingWallSprites = {};
    this.rotatingBarSprites = {};

    this.mapGfx = this.add.graphics();
    const g = this.mapGfx;
    const palette = getThemePalette(this.themeId);

    this.cameras.main.setBackgroundColor(palette.background);
    g.fillStyle(palette.shadow || palette.background, 1);
    g.fillRect(0, 0, MAP_W, MAP_H);
    this.drawArenaBackdrop(g, palette, data);

    for (const wall of data.walls) {
      this.drawWallVisual(g, palette, wall);
    }

    this.drawArenaBorder(g, palette, data);

    for (const wall of data.movingWalls || []) {
      const gfx = this.add.graphics();
      this.movingWallSprites[wall.id] = { gfx };
    }

    for (const bar of data.rotatingBars || []) {
      const gfx = this.add.graphics();
      this.rotatingBarSprites[bar.id] = { gfx };
    }

    this.walls = data.walls;
  }

  drawArenaBackdrop(g, palette, data) {
    const frame = data?.frame || {};
    const inset = frame.inset || 24;
    const cornerCut = frame.cornerCut || 60;
    const octagonPoints = pointsToPhaser(getArenaPolygon(inset, cornerCut));

    switch (frame.kind) {
      case 'octagon':
      case 'temple':
      case 'manor':
        g.fillStyle(palette.floor, 1);
        g.fillPoints(octagonPoints, true);
        break;
      case 'ring':
        g.fillStyle(palette.accent, 0.35);
        g.fillEllipse(MAP_W / 2, MAP_H / 2, MAP_W - 110, MAP_H - 70);
        g.fillStyle(palette.background, 0.88);
        g.fillEllipse(MAP_W / 2, MAP_H / 2, MAP_W - 180, MAP_H - 140);
        g.fillStyle(palette.floor, 1);
        g.fillEllipse(MAP_W / 2, MAP_H / 2, MAP_W - 250, MAP_H - 205);
        break;
      default:
        g.fillStyle(palette.floor, 1);
        g.fillRect(0, 0, MAP_W, MAP_H);
        break;
    }

    if (frame.kind !== 'ring') {
      g.lineStyle(1, palette.grid, this.mapId === 'ice-cavern' ? 0.22 : 0.4);
      for (let x = 70; x < MAP_W - 70; x += this.mapId === 'neon-city' ? 44 : 52) {
        g.beginPath(); g.moveTo(x, 52); g.lineTo(x, MAP_H - 52); g.strokePath();
      }
      for (let y = 52; y < MAP_H - 52; y += this.mapId === 'neon-city' ? 44 : 52) {
        g.beginPath(); g.moveTo(70, y); g.lineTo(MAP_W - 70, y); g.strokePath();
      }
    }

    switch (this.mapId) {
      case 'neon-city':
        g.fillStyle(palette.accent2, 0.16);
        g.fillRect(104, 520, 692, 8);
        g.fillStyle(palette.accent, 0.22);
        g.fillRect(92, 168, 9, 264);
        g.fillRect(799, 168, 9, 264);
        g.fillCircle(450, 300, 66);
        break;
      case 'lava-pit':
        g.fillStyle(palette.background, 0.95);
        g.fillRect(96, 64, MAP_W - 192, MAP_H - 128);
        g.fillStyle(palette.floor, 1);
        g.fillEllipse(MAP_W / 2, MAP_H / 2, MAP_W - 254, MAP_H - 210);
        g.fillStyle(palette.accent2, 0.18);
        g.fillCircle(450, 300, 86);
        break;
      case 'ice-cavern':
        for (const [x, y, r] of [[142, 122, 18], [758, 122, 18], [178, 480, 14], [722, 486, 14], [450, 90, 24]]) {
          g.fillStyle(0xffffff, 0.28);
          g.fillCircle(x, y, r);
        }
        break;
      case 'ancient-ruins':
        g.fillStyle(palette.accent2, 0.18);
        g.fillCircle(170, 455, 38);
        g.fillCircle(730, 455, 38);
        g.fillCircle(210, 146, 38);
        g.fillCircle(690, 146, 38);
        break;
      case 'space-station':
        g.fillStyle(palette.accent3, 0.28);
        g.fillRect(108, 526, 118, 8);
        g.fillRect(674, 526, 118, 8);
        g.fillStyle(palette.accent, 0.18);
        g.fillRect(118, 160, 12, 280);
        g.fillRect(770, 160, 12, 280);
        break;
      case 'desert-temple':
        g.fillStyle(palette.accent2, 0.2);
        g.fillCircle(450, 300, 80);
        break;
      case 'haunted-manor':
        g.fillStyle(palette.accent, 0.18);
        g.fillCircle(450, 300, 92);
        g.fillRect(184, 88, 532, 4);
        g.fillRect(184, 508, 532, 4);
        break;
      case 'jungle-canopy':
        g.fillStyle(palette.accent2, 0.22);
        g.fillCircle(450, 300, 88);
        g.fillRect(354, 92, 192, 12);
        g.fillRect(354, 496, 192, 12);
        break;
    }
  }

  drawArenaBorder(g, palette, data) {
    const frame = data?.frame || {};
    const inset = frame.inset || 24;
    const cornerCut = frame.cornerCut || 60;

    if (frame.kind === 'ring') {
      g.lineStyle(18, palette.accent, 0.42);
      g.strokeEllipse(MAP_W / 2, MAP_H / 2, MAP_W - 112, MAP_H - 72);
      g.lineStyle(6, palette.border, 0.95);
      g.strokeEllipse(MAP_W / 2, MAP_H / 2, MAP_W - 150, MAP_H - 110);
      return;
    }

    if (frame.kind === 'octagon' || frame.kind === 'temple' || frame.kind === 'manor') {
      const points = pointsToPhaser(getArenaPolygon(inset, cornerCut));
      g.lineStyle(12, palette.border, 0.08);
      g.strokePoints(points, true);
      g.lineStyle(4, palette.border, 0.95);
      g.strokePoints(points, true);
      return;
    }

    g.lineStyle(3, palette.border, 1);
    g.strokeRect(1, 1, MAP_W - 2, MAP_H - 2);
  }

  drawWallVisual(g, palette, wall) {
    if (wall.shape === 'circle') {
      this.drawCircleWallVisual(g, palette, wall);
      return;
    }

    const x = wall.x;
    const y = wall.y;
    const w = wall.w;
    const h = wall.h;
    const small = Math.min(w, h) <= 42;
    const tall = h > w * 1.35;

    g.fillStyle(0x000000, 0.32);
    g.fillRect(x + 4, y + 4, w, h);
    g.fillStyle(palette.wall, 1);
    g.fillRect(x, y, w, h);
    g.lineStyle(1, palette.wallEdge, 1);
    g.strokeRect(x, y, w, h);
    g.lineStyle(2, palette.wallTop, 0.45);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y); g.strokePath();

    switch (this.mapId) {
      case 'neon-city':
      case 'space-station':
        g.lineStyle(2, small ? palette.accent3 : palette.accent, small ? 0.8 : 0.55);
        g.strokeRect(x + 6, y + 6, Math.max(10, w - 12), Math.max(10, h - 12));
        if (small) {
          g.beginPath();
          g.moveTo(x + 8, y + h - 8);
          g.lineTo(x + w - 8, y + 8);
          g.strokePath();
        } else if (tall) {
          g.fillStyle(palette.accent2, 0.18);
          g.fillRect(x + w * 0.34, y + 10, w * 0.32, h - 20);
        } else {
          g.fillStyle(palette.accent2, 0.18);
          g.fillRect(x + 10, y + h * 0.34, w - 20, h * 0.32);
        }
        break;
      case 'lava-pit':
        g.lineStyle(2, palette.accent3, 0.65);
        g.strokeRect(x + 7, y + 7, Math.max(8, w - 14), Math.max(8, h - 14));
        if (small) {
          g.beginPath();
          g.moveTo(x + 9, y + 9);
          g.lineTo(x + w - 9, y + h - 9);
          g.moveTo(x + w - 9, y + 9);
          g.lineTo(x + 9, y + h - 9);
          g.strokePath();
        }
        break;
      case 'ice-cavern':
        g.fillStyle(0xffffff, 0.18);
        g.fillRect(x + 5, y + 5, w - 10, Math.max(6, h * 0.24));
        g.lineStyle(2, 0xffffff, 0.35);
        g.beginPath();
        g.moveTo(x + 7, y + h * 0.62);
        g.lineTo(x + w - 7, y + h * 0.38);
        g.strokePath();
        break;
      case 'ancient-ruins':
      case 'desert-temple':
        g.lineStyle(1, palette.accent3, 0.45);
        g.strokeRect(x + 5, y + 5, w - 10, h - 10);
        if (small) {
          g.fillStyle(palette.accent2, 0.16);
          g.fillRect(x + 10, y + 10, w - 20, h - 20);
        } else {
          g.lineStyle(1, palette.wallEdge, 0.45);
          g.beginPath();
          g.moveTo(x + w / 2, y + 6);
          g.lineTo(x + w / 2, y + h - 6);
          g.strokePath();
        }
        break;
      case 'haunted-manor':
        g.fillStyle(palette.accent, 0.12);
        g.fillRect(x + 6, y + 6, w - 12, h - 12);
        g.lineStyle(1, palette.accent3, 0.3);
        g.strokeRect(x + 8, y + 8, w - 16, h - 16);
        break;
      case 'jungle-canopy':
        g.lineStyle(2, palette.accent2, 0.35);
        if (small) {
          g.strokeCircle(x + w / 2, y + h / 2, Math.min(w, h) * 0.24);
        } else {
          g.beginPath();
          g.moveTo(x + w * 0.25, y + h * 0.2);
          g.lineTo(x + w * 0.7, y + h * 0.75);
          g.strokePath();
        }
        break;
    }
  }

  drawCircleWallVisual(g, palette, wall) {
    g.fillStyle(0x000000, 0.35);
    g.fillCircle(wall.x + 4, wall.y + 4, wall.r);
    g.fillStyle(palette.wall, 1);
    g.fillCircle(wall.x, wall.y, wall.r);
    g.lineStyle(2, palette.wallEdge, 1);
    g.strokeCircle(wall.x, wall.y, wall.r);

    switch (this.mapId) {
      case 'lava-pit':
        g.lineStyle(3, palette.accent3, 0.6);
        g.strokeCircle(wall.x, wall.y, wall.r * 0.62);
        break;
      case 'ice-cavern':
        g.fillStyle(0xffffff, 0.2);
        g.fillCircle(wall.x - wall.r * 0.22, wall.y - wall.r * 0.22, wall.r * 0.34);
        break;
      case 'haunted-manor':
        g.lineStyle(2, palette.accent, 0.38);
        g.strokeCircle(wall.x, wall.y, wall.r * 0.56);
        break;
      case 'jungle-canopy':
        g.lineStyle(2, palette.accent2, 0.35);
        g.strokeCircle(wall.x, wall.y, wall.r * 0.42);
        break;
    }
  }

  updateFromState(state) {
    this.bombHolder = state.bombHolder;
    this.bombTimer  = state.bombTimer;

    const serverIds = new Set(state.players.map(p => p.id));

    // Remove stale players
    for (const id of Object.keys(this.players)) {
      if (!serverIds.has(id)) {
        this.destroyPlayer(id);
      }
    }

    // Update / create players
    for (const p of state.players) {
      if (!this.players[p.id]) {
        this.createPlayerGfx(p);
      }
      this.updatePlayerGfx(p);
    }

    // Ticking sound
    if (state.bombHolder && state.bombTimer > 0) {
      const urgency    = 1 - (state.bombTimer / BOMB_TIMER_MS);
      const tickFreqMs = Phaser.Math.Linear(1200, 120, urgency);
      const now        = Date.now();
      if (now - this.lastTickSound > tickFreqMs) {
        this.lastTickSound = now;
        if (state.bombHolder === myPlayerId || true) playTick(urgency);
      }
    }

    // Update HUD
    updateHUD(state);
    this.updateMovingWalls(state.movingWalls || []);
    this.updateRotatingBars(state.rotatingBars || []);
    this.updatePortals(state.portals || []);

    // Pulse vignette effect based on urgency
    if (state.bombHolder === myPlayerId) {
      const urgency = Math.max(0, 1 - state.bombTimer / BOMB_TIMER_MS);
      document.getElementById('game-canvas-wrap').style.boxShadow =
        `inset 0 0 ${urgency * 80}px rgba(255,60,60,${urgency * 0.5})`;
    } else {
      document.getElementById('game-canvas-wrap').style.boxShadow = '';
    }
  }

  updateMovingWalls(movingWalls) {
    const activeIds = new Set(movingWalls.map((wall) => wall.id));
    for (const wall of movingWalls) {
      if (!this.movingWallSprites[wall.id]) {
        this.movingWallSprites[wall.id] = { gfx: this.add.graphics() };
      }
      const sprite = this.movingWallSprites[wall.id].gfx;
      sprite.clear();
      sprite.fillStyle(0x6d7688, 0.95);
      sprite.fillRect(wall.x, wall.y, wall.w, wall.h);
      sprite.lineStyle(2, 0xc0c8d8, 0.8);
      sprite.strokeRect(wall.x, wall.y, wall.w, wall.h);
    }

    for (const [id, sprite] of Object.entries(this.movingWallSprites)) {
      if (!activeIds.has(id)) {
        sprite.gfx.clear();
      }
    }
  }

  updateRotatingBars(rotatingBars) {
    const activeIds = new Set(rotatingBars.map((bar) => bar.id));
    for (const bar of rotatingBars) {
      if (!this.rotatingBarSprites[bar.id]) {
        this.rotatingBarSprites[bar.id] = { gfx: this.add.graphics() };
      }
      const gfx = this.rotatingBarSprites[bar.id].gfx;
      const half = bar.length / 2;
      const x1 = bar.x + Math.cos(bar.angle) * half;
      const y1 = bar.y + Math.sin(bar.angle) * half;
      const x2 = bar.x - Math.cos(bar.angle) * half;
      const y2 = bar.y - Math.sin(bar.angle) * half;
      gfx.clear();
      gfx.lineStyle(bar.thickness, 0xffd166, 0.9);
      gfx.beginPath();
      gfx.moveTo(x1, y1);
      gfx.lineTo(x2, y2);
      gfx.strokePath();
      gfx.fillStyle(0xff8c42, 0.95);
      gfx.fillCircle(bar.x, bar.y, bar.thickness * 0.55);
    }

    for (const [id, sprite] of Object.entries(this.rotatingBarSprites)) {
      if (!activeIds.has(id)) sprite.gfx.clear();
    }
  }

  updatePortals(portals) {
    const activeIds = new Set(portals.map((portal) => portal.id));
    for (const portal of portals) {
      let sprite = this.portals.find((candidate) => candidate.id === portal.id);
      if (!sprite) {
        const container = this.add.container(portal.x, portal.y);
        const gfx = this.add.graphics();
        container.add(gfx);
        container.setScale(0.18);
        this.tweens.add({
          targets: container,
          scaleX: 1,
          scaleY: 1,
          duration: 260,
          ease: 'Back.Out',
        });
        sprite = { id: portal.id, container, gfx, color: 0x33e7ff, role: portal.role || 'entry', ...portal };
        this.portals.push(sprite);
      }
      Object.assign(sprite, portal);
      sprite.container.setPosition(portal.x, portal.y);
    }

    for (const portal of [...this.portals]) {
      if (activeIds.has(portal.id)) continue;
      this.portals = this.portals.filter((candidate) => candidate.id !== portal.id);
      portal.container.destroy();
    }
  }

  createPlayerGfx(p) {
    const container = this.add.container(p.x, p.y);

    // Shadow
    const shadow = this.add.graphics();
    shadow.fillStyle(0x000000, 0.35);
    shadow.fillEllipse(4, 6, PLAYER_RADIUS*2.2, PLAYER_RADIUS*1.2);

    // Aura (visible when has bomb)
    const aura = this.add.graphics();

    const frame = this.add.graphics();
    frame.fillStyle(0x162033, 0.95);
    frame.fillCircle(0, 0, PLAYER_RADIUS + 5);
    frame.lineStyle(2, 0x6ea2ff, 0.45);
    frame.strokeCircle(0, 0, PLAYER_RADIUS + 5);

    // Body
    const body = this.add.image(0, 2, getCharacterTextureKey(p.characterId));
    body.setOrigin(0.5, 0.76);
    body.setScale(0.058);

    // Visor
    const visor = this.add.graphics();
    visor.fillStyle(0xffffff, 0.08);
    visor.fillCircle(-3, -6, 12);

    // Name
    const nameText = this.add.text(0, -PLAYER_RADIUS - 18, p.name, {
      fontFamily: 'Rajdhani', fontSize: '13px', fontStyle: 'bold',
      color: '#ffffff',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5);

    // Bomb icon
    const bombText = this.add.text(0, 0, '💣', {
      fontSize: '18px',
    }).setOrigin(0.5).setVisible(false);

    container.add([shadow, aura, frame, body, visor, nameText, bombText]);

    this.players[p.id] = {
      container, shadow, aura, frame, body, visor, nameText, bombText,
      color: p.color, px: p.x, py: p.y,
      alive: p.alive,
    };
  }

  updatePlayerGfx(p) {
    const obj = this.players[p.id];
    if (!obj) return;

    // Smooth interpolation
    obj.px = Phaser.Math.Linear(obj.px, p.x, 0.35);
    obj.py = Phaser.Math.Linear(obj.py, p.y, 0.35);
    obj.container.setPosition(obj.px, obj.py);

    const hasBomb = p.hasBomb;
    const stunned = !!p.statusEffects?.stunned;
    obj.alive = p.alive;

    if (!p.alive) {
      obj.container.setAlpha(0.2);
      obj.aura.clear();
      obj.bombText.setVisible(false);
      return;
    }
    obj.container.setAlpha(stunned ? 0.82 : 1);

    // Dash effect
    if (p.dashActive) {
      obj.body.setAlpha(0.7);
      // trail effect — draw ghost
    } else {
      obj.body.setAlpha(1);
    }

    obj.frame.clear();
    obj.frame.fillStyle(stunned ? 0x284463 : 0x162033, 0.95);
    obj.frame.fillCircle(0, 0, PLAYER_RADIUS + 5);
    obj.frame.lineStyle(stunned ? 3 : 2, stunned ? 0x8ce8ff : 0x6ea2ff, stunned ? 0.9 : 0.45);
    obj.frame.strokeCircle(0, 0, PLAYER_RADIUS + 5);

    // Bomb visuals
    if (hasBomb) {
      obj.bombText.setVisible(true);
      const t = this.time.now / 1000;
      const urgency = Math.max(0, 1 - this.bombTimer / BOMB_TIMER_MS);
      const pulse = 0.4 + 0.6 * urgency + Math.sin(t * (4 + urgency * 12)) * 0.3;

      obj.aura.clear();
      obj.aura.lineStyle(3 + pulse * 4, 0xff4400, 0.5 + pulse * 0.4);
      obj.aura.strokeCircle(0, 0, PLAYER_RADIUS + 8 + pulse * 6);
      obj.aura.lineStyle(1, 0xffaa00, 0.3 + pulse * 0.4);
      obj.aura.strokeCircle(0, 0, PLAYER_RADIUS + 14 + pulse * 10);

      // Jitter if very urgent
      if (urgency > 0.7) {
        const jitter = urgency * 3;
        obj.container.x += (Math.random() - 0.5) * jitter;
        obj.container.y += (Math.random() - 0.5) * jitter;
      }
    } else {
      obj.aura.clear();
      obj.bombText.setVisible(false);
    }

    // Self highlight
    if (p.id === myPlayerId) {
      obj.body.setAlpha(1);
    }
  }

  destroyPlayer(id) {
    const obj = this.players[id];
    if (!obj) return;
    obj.container.destroy();
    delete this.players[id];
  }

  spawnExplosion(playerId) {
    const obj = this.players[playerId];
    const x = obj ? obj.px : MAP_W/2;
    const y = obj ? obj.py : MAP_H/2;

    // Explosion particles
    for (let i = 0; i < 40; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 320;
      const size  = 3 + Math.random() * 8;
      const col   = [0xff4400, 0xffaa00, 0xff8800, 0xffff44, 0xffffff][Math.floor(Math.random()*5)];
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size, col,
        life: 1.0,
        decay: 0.6 + Math.random() * 0.8,
      });
    }

    // Explosion rings
    for (let r = 0; r < 3; r++) {
      const ring = this.add.graphics();
      ring.lineStyle(3, 0xff6600, 0.8);
      ring.strokeCircle(x, y, 20);
      this.tweens.add({
        targets: ring,
        duration: 500 + r * 200,
        delay: r * 100,
        onUpdate: (tween) => {
          const prog = tween.progress;
          ring.clear();
          ring.lineStyle(3*(1-prog), 0xff6600, (1-prog)*0.8);
          ring.strokeCircle(x, y, 20 + prog * 150);
        },
        onComplete: () => ring.destroy(),
      });
    }

    // Flash
    const flash = this.add.graphics();
    flash.fillStyle(0xffffff, 1);
    flash.fillRect(0, 0, MAP_W, MAP_H);
    this.tweens.add({
      targets: flash, alpha: 0, duration: 300,
      onComplete: () => flash.destroy(),
    });
  }

  update(time, delta) {
    const dt = delta / 1000;

    // Update particles
    if (this.particleGraphics && this.particles.length > 0) {
      this.particleGraphics.clear();
      this.particles = this.particles.filter(p => p.life > 0);
      for (const p of this.particles) {
        p.x   += p.vx * dt;
        p.y   += p.vy * dt;
        p.vy  += 300 * dt; // gravity
        p.life -= p.decay * dt;
        if (p.life <= 0) continue;
        this.particleGraphics.fillStyle(p.col, p.life);
        this.particleGraphics.fillRect(p.x, p.y, p.size * p.life, p.size * p.life);
      }
    }

    // Animate portals
    for (const portal of this.portals) {
      const isEntry = portal.role === 'entry';
      const primary = isEntry ? 0x33e7ff : 0x7f8da5;
      const secondary = isEntry ? 0xb8fff7 : 0xc9d3e5;
      const inner = isEntry ? 0x6f5cff : 0x4f5b6d;
      const alphaBase = isEntry ? 0.13 : 0.06;
      const pulse = 0.5 + Math.sin(time / 150 + portal.x * 0.01) * 0.5;
      const radius = (isEntry ? 19 : 16) + pulse * (isEntry ? 5 : 2);
      portal.gfx.clear();
      portal.gfx.fillStyle(primary, alphaBase);
      portal.gfx.fillCircle(0, 0, radius + 8);
      portal.gfx.lineStyle(isEntry ? 4 : 3, secondary, (isEntry ? 0.35 : 0.18) + pulse * (isEntry ? 0.5 : 0.22));
      portal.gfx.strokeCircle(0, 0, radius);
      portal.gfx.lineStyle(2, inner, (isEntry ? 0.45 : 0.2) + pulse * (isEntry ? 0.35 : 0.14));
      portal.gfx.strokeCircle(0, 0, radius * 0.58);
      portal.gfx.lineStyle(1, 0xffffff, isEntry ? 0.4 : 0.18);
      portal.gfx.beginPath();
      for (let i = 0; i < 9; i++) {
        const angle = time / 360 + i * Math.PI * 2 / 9;
        const inner = radius * 0.32;
        const outer = radius * (0.78 + pulse * 0.14);
        portal.gfx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
        portal.gfx.lineTo(Math.cos(angle + 0.45) * outer, Math.sin(angle + 0.45) * outer);
      }
      portal.gfx.strokePath();
    }
  }
}

// ─── INPUT HANDLING ───────────────────────────────────────────────────────────
const keys = { up:false, down:false, left:false, right:false, dash:false };
let lastSentInputs = {};

document.addEventListener('keydown', (e) => {
  if (currentPhase !== 'playing') return;
  handleKey(e.code, true);
});
document.addEventListener('keyup', (e) => {
  handleKey(e.code, false);
});

function handleKey(code, down) {
  const prev = { ...keys };
  switch(code) {
    case 'KeyW': case 'ArrowUp':    keys.up    = down; break;
    case 'KeyS': case 'ArrowDown':  keys.down  = down; break;
    case 'KeyA': case 'ArrowLeft':  keys.left  = down; break;
    case 'KeyD': case 'ArrowRight': keys.right = down; break;
    case 'Space':
      if (down && !prev.dash) keys.dash = true;
      if (!down) keys.dash = false;
      break;
  }

  const changed = Object.keys(keys).some(k => keys[k] !== lastSentInputs[k]);
  if (changed || keys.dash) {
    socket.emit('playerInput', { ...keys });
    lastSentInputs = { ...keys };
    if (keys.dash) keys.dash = false; // send dash as one-shot
  }
}

// ─── PHASER INIT ─────────────────────────────────────────────────────────────
let phaserGame = null;

function initPhaser() {
  if (phaserGame) return;

  const canvas = document.getElementById('gameCanvas');

  phaserGame = new Phaser.Game({
    type: Phaser.CANVAS,
    canvas: canvas,
    parent: 'game-canvas-wrap',
    width:  MAP_W,
    height: MAP_H,
    backgroundColor: '#080b12',
    scene: GameScene,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: MAP_W,
      height: MAP_H,
    },
    render: { antialias: true, pixelArt: false },
  });
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────
function ensureSocketConnection() {
  const targetUrl = currentServerUrl || normalizeServerUrl(resolveSocketServerUrl()) || window.location.origin;
  const shouldReconnect = !socket || currentServerUrl !== targetUrl;

  if (shouldReconnect) {
    connectSocket(targetUrl);
    return;
  }

  if (!socket.connected) {
    socket.connect();
    setConnectionStatus('Connecting to server...');
  }
}

function registerSocketEvents() {
socket.on('connect', () => {
  console.log('Connected:', socket.id);
  setConnectionStatus('Connected to server', 'connected');
  setError('');
  setWaitingMessage('');
});

socket.on('connect_error', () => {
  setConnectionStatus('Could not connect to server', 'error');
  if (currentPhase === 'waiting') {
    setWaitingMessage('Cannot reach the game server right now.');
  } else {
    setError('Cannot reach the game server right now.');
  }
});

socket.on('roomCreated', (data) => {
  myPlayerId = data.playerId;
  myRoomId   = data.roomId;
  currentHostId = data.hostId || data.playerId;
  mapData    = data.mapData;
  latestRoomPlayers = (data.players || []).map((player) => ({ ...player }));
  currentPhase = 'waiting';
  document.getElementById('display-room-code').textContent = data.roomId;
  renderWaitingRoom(data.players);
  updateWaitingControls(data.players);
  showScreen('screen-waiting');
  setError('');
  setWaitingMessage('');
});

socket.on('roomJoined', (data) => {
  myPlayerId = data.playerId;
  myRoomId   = data.roomId;
  currentHostId = data.hostId || null;
  mapData    = data.mapData;
  latestRoomPlayers = (data.players || []).map((player) => ({ ...player }));
  currentPhase = 'waiting';
  document.getElementById('display-room-code').textContent = data.roomId;
  renderWaitingRoom(data.players);
  updateWaitingControls(data.players);
  showScreen('screen-waiting');
  setError('');
  setWaitingMessage('');
});

socket.on('roomState', (data) => {
  applyRoomState(data);
});

socket.on('backToLobby', (data) => {
  currentPhase = 'waiting';
  currentHostId = data.hostId || currentHostId;
  latestRoomPlayers = (data.players || []).map((player) => ({ ...player }));
  renderWaitingRoom(data.players);
  updateWaitingControls(data.players);
  setWaitingMessage('');
  showScreen('screen-waiting');
});

socket.on('roomError', (data) => {
  if (currentPhase === 'waiting') {
    setWaitingMessage(data.msg);
  } else {
    setError(data.msg);
  }
});

socket.on('countdownCancelled', (data) => {
  currentPhase = 'waiting';
  document.getElementById('countdown-overlay').classList.add('hidden');
  showScreen('screen-waiting');
  setWaitingMessage(data.msg || 'Countdown cancelled');
});

socket.on('countdown', (data) => {
  if (data.value === 3) {
    currentPhase = 'countdown';
    // Switch to game screen, init phaser
    showScreen('screen-game');
    initPhaser();
  }
  const overlay = document.getElementById('countdown-overlay');
  const num     = document.getElementById('countdown-number');
  overlay.classList.remove('hidden');
  num.textContent = data.value;
  // re-trigger animation
  num.style.animation = 'none';
  void num.offsetWidth;
  num.style.animation = '';

  setTimeout(() => {
    if (data.value === 1) overlay.classList.add('hidden');
  }, 850);
});

socket.on('gameStart', (data) => {
  currentPhase = 'playing';
  document.getElementById('countdown-overlay').classList.add('hidden');
  mapData = data.mapData;

  // Update scores
  if (data.scores) localScores = data.scores;

  if (gameScene) {
    gameScene.buildMap(mapData);
    gameScene.prepareForRound(data.firstBombHolder);
  }

  showGameMessage(`GO! ${mapData?.theme?.name || 'Arena'} rules are live`, 1800);
});

socket.on('gameState', (state) => {
  if (currentPhase !== 'playing') return;
  latestRoomPlayers = (state.players || []).map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    characterId: player.characterId,
    avatarUrl: player.avatarUrl,
  }));
  if (gameScene) gameScene.updateFromState(state);
});

socket.on('bombTransfer', (data) => {
  playBombTransfer();
  if (data.to === myPlayerId) {
    showGameMessage('💣 YOU HAVE THE BOMB!', 1500);
  }
});

socket.on('explosion', (data) => {
  playExplosion();
  triggerScreenShake();

  if (gameScene) gameScene.spawnExplosion(data.playerId);

  const msg = data.playerId === myPlayerId
    ? '💥 YOU EXPLODED!'
    : `💥 ${data.name} exploded!`;
  showGameMessage(msg, 2000);
});

socket.on('hazardEliminated', (data) => {
  const msg = data.playerId === myPlayerId
    ? `You were consumed by ${data.hazard}!`
    : `${data.name} fell to ${data.hazard}!`;
  showGameMessage(msg, 2200);
});

socket.on('portalUsed', (data) => {
  playTeleport();
});

socket.on('gameOver', (data) => {
  currentPhase = 'gameover';

  // Update localScores
  if (data.scores) {
    data.scores.forEach(s => { localScores[s.id] = s.score; });
  }

  const winnerEl = document.getElementById('winner-display');
  if (data.winner) {
    const isMe = data.winner.id === myPlayerId;
    winnerEl.innerHTML = `
      <span class="winner-crown">${isMe ? '🏆' : '🎖️'}</span>
      <h2>${isMe ? 'YOU WIN!' : 'WINNER'}</h2>
      ${renderAvatarMarkup(data.winner, 'winner-avatar')}
      <div class="winner-name" style="color:${isMe ? '#ffcc00' : '#fff'}">${escapeHtml(data.winner.name)}</div>
    `;
  } else {
    winnerEl.innerHTML = `<h2>DRAW!</h2>`;
  }

  const scoresEl = document.getElementById('final-scores');
  scoresEl.innerHTML = '';
  const sorted = [...(data.scores || [])].sort((a,b) => b.score - a.score);
  sorted.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'final-score-row';
    row.innerHTML = `
      <div class="final-score-rank">${i+1}</div>
      ${renderAvatarMarkup(s, 'final-score-avatar')}
      <div class="final-score-name">${escapeHtml(s.name)}</div>
      <div class="final-score-wins">${s.score} wins</div>
    `;
    scoresEl.appendChild(row);
  });

  setTimeout(() => showScreen('screen-gameover'), 800);
});

socket.on('playerLeft', (data) => {
  if (currentPhase === 'waiting') {
    setWaitingMessage(`${data.name} left the room`);
  }
});

socket.on('disconnect', () => {
  setConnectionStatus('Disconnected from server', 'error');
  if (currentPhase === 'playing') {
    showGameMessage('Disconnected from server', 3000);
  } else {
    setError('Disconnected from server. Please refresh and try again.');
  }
});
}

// ─── KICK OFF ─────────────────────────────────────────────────────────────────
connectSocket(resolveSocketServerUrl());
showScreen('screen-lobby');

// Prevent space bar from scrolling page
window.addEventListener('keydown', e => {
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
    if (currentPhase === 'playing') e.preventDefault();
  }
});
