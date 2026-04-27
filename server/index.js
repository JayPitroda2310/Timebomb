const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, '../client')));
app.use('/characters', express.static(path.join(__dirname, '../characters')));
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const MAP_W = 900;
const MAP_H = 600;
const GRID_COLS = 9;
const GRID_ROWS = 6;
const CELL_W = MAP_W / GRID_COLS;
const CELL_H = MAP_H / GRID_ROWS;
const PLAYER_RADIUS = 18;
const PLAYER_SPEED = 220;
const DASH_SPEED = 650;
const DASH_DURATION = 0.18;
const DASH_COOLDOWN = 1.2;
const BOMB_TIMER_START = 60000;
const PASS_COOLDOWN = 1000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const PORTAL_RADIUS = 24;
const PORTAL_COOLDOWN_MS = 400;
const PORTAL_SWAP_INTERVAL_MS = 10000;

const CHARACTER_OPTIONS = [
  {
    id: 'forest-ranger-1',
    avatarUrl: '/characters/Forest_Ranger_1/PNG/PNG%20Sequences/Idle/0_Forest_Ranger_Idle_000.png',
  },
  {
    id: 'forest-ranger-2',
    avatarUrl: '/characters/Forest_Ranger_2/PNG/PNG%20Sequences/Idle/0_Forest_Ranger_Idle_000.png',
  },
  {
    id: 'forest-ranger-3',
    avatarUrl: '/characters/Forest_Ranger_3/PNG/PNG%20Sequences/Idle/0_Forest_Ranger_Idle_000.png',
  },
];

const DEFAULT_SPAWN_CELLS = [
  { col: 1, row: 1 },
  { col: 7, row: 4 },
  { col: 4, row: 1 },
  { col: 4, row: 4 },
  { col: 1, row: 4 },
  { col: 7, row: 1 },
];

const rooms = new Map();

function createRoom(roomId) {
  return {
    id: roomId,
    players: new Map(),
    hostId: null,
    phase: 'lobby',
    bombHolder: null,
    bombTimer: BOMB_TIMER_START,
    lastTick: Date.now(),
    tickInterval: null,
    countdown: 3,
    countdownInterval: null,
    roundWinner: null,
    scores: {},
    map: null,
  };
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function choice(items) {
  return items[randomInt(items.length)];
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toWorldPosition(cell) {
  return {
    x: cell.col * CELL_W + CELL_W / 2,
    y: cell.row * CELL_H + CELL_H / 2,
  };
}

function createPlayer(socketId, name, spawnIndex) {
  const spawn = toWorldPosition(DEFAULT_SPAWN_CELLS[spawnIndex % DEFAULT_SPAWN_CELLS.length]);
  const character = CHARACTER_OPTIONS[spawnIndex % CHARACTER_OPTIONS.length];
  return {
    id: socketId,
    name: name || `Player ${spawnIndex + 1}`,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    alive: true,
    hasBomb: false,
    inputs: { up: false, down: false, left: false, right: false, dash: false },
    dashActive: false,
    dashTimer: 0,
    dashCooldown: 0,
    dashDirX: 0,
    dashDirY: 0,
    passCooldown: 0,
    portalCooldown: 0,
    spawnIndex,
    color: ['#FF4444', '#44AAFF', '#44FF88', '#FFBB44', '#FF44FF', '#44FFFF'][spawnIndex % 6],
    characterId: character.id,
    avatarUrl: character.avatarUrl,
  };
}

function getPublicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    characterId: p.characterId,
    avatarUrl: p.avatarUrl,
  }));
}

function emitRoomState(room) {
  io.to(room.id).emit('roomState', {
    roomId: room.id,
    hostId: room.hostId,
    phase: room.phase,
    players: getPublicPlayers(room),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
  });
}

function clearCountdown(room) {
  if (room.countdownInterval) {
    clearInterval(room.countdownInterval);
    room.countdownInterval = null;
  }
  room.countdown = 3;
}

function assignNextHost(room) {
  room.hostId = room.players.keys().next().value || null;
}

function getAllOpenCells() {
  const cells = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      cells.push({ col, row });
    }
  }
  return cells;
}

function rect(x, y, w, h) {
  return { shape: 'rect', x, y, w, h };
}

function circle(x, y, r) {
  return { shape: 'circle', x, y, r };
}

function createPortals(points) {
  return points.flatMap((pair, index) => ([
    {
      id: `TELEPORT-${index + 1}-A`,
      pairId: `P${index + 1}`,
      side: 0,
      kind: 'teleport',
      x: pair[0].x,
      y: pair[0].y,
    },
    {
      id: `TELEPORT-${index + 1}-B`,
      pairId: `P${index + 1}`,
      side: 1,
      kind: 'teleport',
      x: pair[1].x,
      y: pair[1].y,
    },
  ]));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMapDefinition({ id, themeId, visualId = id, name, walls, portals, spawns, frame }) {
  return {
    id,
    width: MAP_W,
    height: MAP_H,
    grid: { cols: GRID_COLS, rows: GRID_ROWS, cellW: CELL_W, cellH: CELL_H },
    theme: { id: themeId, visualId, name },
    walls,
    portals,
    spawns,
    frame,
    rotatingBars: [],
    movingWalls: [],
  };
}

const MAP_LIBRARY = [
  createMapDefinition({
    id: 'neon-city',
    themeId: 'industrial',
    name: 'Neon City',
    frame: { kind: 'octagon', inset: 26, cornerCut: 62 },
    spawns: [
      { x: 152, y: 110 }, { x: 748, y: 110 }, { x: 152, y: 490 },
      { x: 748, y: 490 }, { x: 450, y: 120 }, { x: 450, y: 480 },
    ],
    portals: createPortals([
      [{ x: 150, y: 468 }, { x: 750, y: 468 }],
      [{ x: 250, y: 132 }, { x: 650, y: 132 }],
    ]),
    walls: [
      rect(390, 235, 120, 130),
      rect(286, 180, 42, 118),
      rect(572, 180, 42, 118),
      rect(286, 320, 42, 118),
      rect(572, 320, 42, 118),
      rect(358, 176, 50, 38),
      rect(492, 176, 50, 38),
      rect(358, 388, 50, 38),
      rect(492, 388, 50, 38),
      rect(202, 226, 44, 44),
      rect(654, 226, 44, 44),
      rect(202, 330, 44, 44),
      rect(654, 330, 44, 44),
      rect(144, 120, 28, 28),
      rect(728, 120, 28, 28),
      rect(144, 452, 28, 28),
      rect(728, 452, 28, 28),
    ],
  }),
  createMapDefinition({
    id: 'lava-pit',
    themeId: 'lava',
    name: 'Lava Pit',
    frame: { kind: 'ring', inset: 24 },
    spawns: [
      { x: 188, y: 126 }, { x: 712, y: 126 }, { x: 188, y: 474 },
      { x: 712, y: 474 }, { x: 450, y: 112 }, { x: 450, y: 488 },
    ],
    portals: createPortals([
      [{ x: 238, y: 146 }, { x: 662, y: 454 }],
      [{ x: 238, y: 454 }, { x: 662, y: 146 }],
    ]),
    walls: [
      circle(450, 300, 54),
      rect(320, 198, 70, 42),
      rect(510, 198, 70, 42),
      rect(320, 360, 70, 42),
      rect(510, 360, 70, 42),
      rect(202, 244, 44, 44),
      rect(654, 244, 44, 44),
      rect(202, 312, 44, 44),
      rect(654, 312, 44, 44),
      rect(404, 124, 38, 38),
      rect(458, 124, 38, 38),
      rect(404, 438, 38, 38),
      rect(458, 438, 38, 38),
      rect(142, 156, 30, 30),
      rect(728, 156, 30, 30),
      rect(142, 414, 30, 30),
      rect(728, 414, 30, 30),
      rect(250, 90, 30, 30),
      rect(620, 90, 30, 30),
      rect(250, 480, 30, 30),
      rect(620, 480, 30, 30),
    ],
  }),
  createMapDefinition({
    id: 'ice-cavern',
    themeId: 'ice',
    name: 'Ice Cavern',
    frame: { kind: 'octagon', inset: 18, cornerCut: 72 },
    spawns: [
      { x: 172, y: 122 }, { x: 728, y: 122 }, { x: 172, y: 478 },
      { x: 728, y: 478 }, { x: 450, y: 108 }, { x: 450, y: 492 },
    ],
    portals: createPortals([
      [{ x: 180, y: 448 }, { x: 720, y: 448 }],
      [{ x: 215, y: 150 }, { x: 685, y: 150 }],
    ]),
    walls: [
      rect(384, 248, 132, 80),
      rect(310, 138, 62, 110),
      rect(528, 138, 62, 110),
      rect(310, 352, 62, 110),
      rect(528, 352, 62, 110),
      rect(398, 128, 42, 42),
      rect(460, 128, 42, 42),
      rect(398, 430, 42, 42),
      rect(460, 430, 42, 42),
      circle(246, 214, 18),
      circle(654, 214, 18),
      circle(246, 386, 18),
      circle(654, 386, 18),
    ],
  }),
  createMapDefinition({
    id: 'ancient-ruins',
    themeId: 'ruins',
    name: 'Ancient Ruins',
    frame: { kind: 'temple', inset: 30 },
    spawns: [
      { x: 174, y: 132 }, { x: 726, y: 132 }, { x: 174, y: 468 },
      { x: 726, y: 468 }, { x: 450, y: 116 }, { x: 450, y: 484 },
    ],
    portals: createPortals([
      [{ x: 170, y: 455 }, { x: 730, y: 455 }],
      [{ x: 210, y: 146 }, { x: 690, y: 146 }],
    ]),
    walls: [
      rect(410, 250, 80, 100),
      rect(278, 138, 42, 42),
      rect(388, 120, 48, 48),
      rect(464, 120, 48, 48),
      rect(580, 138, 42, 42),
      rect(244, 220, 38, 38),
      rect(330, 220, 38, 38),
      rect(532, 220, 38, 38),
      rect(618, 220, 38, 38),
      rect(244, 346, 38, 38),
      rect(330, 346, 38, 38),
      rect(532, 346, 38, 38),
      rect(618, 346, 38, 38),
      rect(278, 420, 42, 42),
      rect(388, 432, 48, 48),
      rect(464, 432, 48, 48),
      rect(580, 420, 42, 42),
    ],
  }),
  createMapDefinition({
    id: 'space-station',
    themeId: 'industrial',
    name: 'Space Station',
    frame: { kind: 'octagon', inset: 18, cornerCut: 66 },
    spawns: [
      { x: 166, y: 128 }, { x: 734, y: 128 }, { x: 166, y: 472 },
      { x: 734, y: 472 }, { x: 450, y: 112 }, { x: 450, y: 488 },
    ],
    portals: createPortals([
      [{ x: 208, y: 156 }, { x: 692, y: 156 }],
      [{ x: 196, y: 456 }, { x: 704, y: 456 }],
    ]),
    walls: [
      rect(388, 92, 124, 74),
      rect(384, 246, 132, 108),
      rect(278, 188, 56, 40),
      rect(566, 188, 56, 40),
      rect(278, 372, 56, 40),
      rect(566, 372, 56, 40),
      rect(214, 226, 40, 146),
      rect(646, 226, 40, 146),
      rect(320, 164, 78, 42),
      rect(502, 164, 78, 42),
      rect(320, 394, 78, 42),
      rect(502, 394, 78, 42),
    ],
  }),
  createMapDefinition({
    id: 'desert-temple',
    themeId: 'desert',
    name: 'Desert Temple',
    frame: { kind: 'octagon', inset: 26, cornerCut: 62 },
    spawns: [
      { x: 184, y: 126 }, { x: 716, y: 126 }, { x: 184, y: 474 },
      { x: 716, y: 474 }, { x: 450, y: 110 }, { x: 450, y: 490 },
    ],
    portals: createPortals([
      [{ x: 206, y: 162 }, { x: 694, y: 438 }],
      [{ x: 206, y: 438 }, { x: 694, y: 162 }],
    ]),
    walls: [
      rect(392, 256, 116, 88),
      rect(306, 152, 88, 40),
      rect(506, 152, 88, 40),
      rect(306, 408, 88, 40),
      rect(506, 408, 88, 40),
      rect(226, 192, 42, 42),
      rect(632, 192, 42, 42),
      rect(226, 366, 42, 42),
      rect(632, 366, 42, 42),
      rect(364, 116, 40, 40),
      rect(496, 116, 40, 40),
      rect(364, 444, 40, 40),
      rect(496, 444, 40, 40),
    ],
  }),
  createMapDefinition({
    id: 'haunted-manor',
    themeId: 'haunted',
    name: 'Haunted Manor',
    frame: { kind: 'manor', inset: 24 },
    spawns: [
      { x: 190, y: 124 }, { x: 710, y: 124 }, { x: 190, y: 476 },
      { x: 710, y: 476 }, { x: 450, y: 112 }, { x: 450, y: 488 },
    ],
    portals: createPortals([
      [{ x: 176, y: 444 }, { x: 724, y: 444 }],
      [{ x: 208, y: 150 }, { x: 692, y: 150 }],
    ]),
    walls: [
      circle(450, 300, 58),
      rect(306, 168, 52, 104),
      rect(542, 168, 52, 104),
      rect(306, 328, 52, 104),
      rect(542, 328, 52, 104),
      rect(392, 162, 42, 42),
      rect(466, 162, 42, 42),
      rect(392, 396, 42, 42),
      rect(466, 396, 42, 42),
      rect(220, 238, 34, 34),
      rect(646, 238, 34, 34),
      rect(220, 328, 34, 34),
      rect(646, 328, 34, 34),
    ],
  }),
  createMapDefinition({
    id: 'jungle-canopy',
    themeId: 'jungle',
    name: 'Jungle Canopy',
    frame: { kind: 'temple', inset: 22 },
    spawns: [
      { x: 188, y: 122 }, { x: 712, y: 122 }, { x: 188, y: 478 },
      { x: 712, y: 478 }, { x: 450, y: 108 }, { x: 450, y: 492 },
    ],
    portals: createPortals([
      [{ x: 186, y: 448 }, { x: 714, y: 448 }],
      [{ x: 198, y: 148 }, { x: 702, y: 148 }],
    ]),
    walls: [
      circle(450, 300, 56),
      circle(306, 220, 28),
      circle(594, 220, 28),
      circle(306, 380, 28),
      circle(594, 380, 28),
      circle(238, 184, 24),
      circle(662, 184, 24),
      circle(238, 416, 24),
      circle(662, 416, 24),
      rect(394, 118, 112, 40),
      rect(394, 442, 112, 40),
      rect(430, 176, 40, 40),
      rect(430, 384, 40, 40),
    ],
  }),
];

function generateMatchMap(_playerCount) {
  const template = choice(MAP_LIBRARY);
  const map = clone(template);
  map.openCells = getAllOpenCells();
  map.portalRadius = PORTAL_RADIUS;
  map.portalCooldownMs = PORTAL_COOLDOWN_MS;
  map.portalSwapStartedAt = Date.now();
  map.portalSwapIntervalMs = PORTAL_SWAP_INTERVAL_MS;
  return map;
}

function getActiveMovingWalls(map, now) {
  return (map.movingWalls || []).map((wall) => {
    const oscillation = Math.sin(now / 1000 * wall.speed + wall.phase) * wall.range;
    return {
      id: wall.id,
      axis: wall.axis,
      x: wall.baseX + (wall.axis === 'x' ? oscillation : 0),
      y: wall.baseY + (wall.axis === 'y' ? oscillation : 0),
      w: wall.w,
      h: wall.h,
    };
  });
}

function getActiveRotatingBars(map, now) {
  return (map.rotatingBars || []).map((bar) => ({
    ...bar,
    angle: bar.angle + (now / 1000) * bar.angularSpeed,
  }));
}

function getAllWalls(map, now) {
  return [...(map.walls || []), ...getActiveMovingWalls(map, now)];
}

function circleOverlapsObstacle(x, y, radius, obstacle) {
  if (obstacle.shape === 'circle') {
    return Math.hypot(x - obstacle.x, y - obstacle.y) < radius + obstacle.r;
  }
  return (
    x + radius > obstacle.x &&
    x - radius < obstacle.x + obstacle.w &&
    y + radius > obstacle.y &&
    y - radius < obstacle.y + obstacle.h
  );
}

function circleOverlapsBar(x, y, radius, bar, now) {
  const activeBar = {
    ...bar,
    angle: bar.angle + (now / 1000) * bar.angularSpeed,
  };
  const half = activeBar.length / 2;
  const x1 = activeBar.x + Math.cos(activeBar.angle) * half;
  const y1 = activeBar.y + Math.sin(activeBar.angle) * half;
  const x2 = activeBar.x - Math.cos(activeBar.angle) * half;
  const y2 = activeBar.y - Math.sin(activeBar.angle) * half;
  return pointToSegmentDistance(x, y, x1, y1, x2, y2).distance < radius + activeBar.thickness / 2;
}

function isValidTeleportPoint(map, x, y, players, now, radius = PLAYER_RADIUS) {
  if (x < radius || x > MAP_W - radius || y < radius || y > MAP_H - radius) return false;
  const activeWalls = getAllWalls(map, now);
  if (activeWalls.some((wall) => circleOverlapsObstacle(x, y, radius, wall))) return false;
  if ((map.rotatingBars || []).some((bar) => circleOverlapsBar(x, y, radius + 8, bar, now))) return false;
  if ((players || []).some((player) => player.alive && Math.hypot(player.x - x, player.y - y) < radius + PLAYER_RADIUS + 18)) return false;
  return true;
}

function getActivePortalRole(map, portal, now) {
  const startedAt = map.portalSwapStartedAt || now;
  const interval = map.portalSwapIntervalMs || PORTAL_SWAP_INTERVAL_MS;
  const phase = Math.floor((now - startedAt) / interval) % 2;
  return portal.side === phase ? 'entry' : 'exit';
}

function getLinkedPortal(map, portal) {
  return (map.portals || []).find((candidate) => (
    candidate.pairId === portal.pairId && candidate.id !== portal.id
  )) || null;
}

function getPortalState(map, now) {
  return (map.portals || []).map((portal) => ({
    ...portal,
    role: getActivePortalRole(map, portal, now),
    targetId: getLinkedPortal(map, portal)?.id || null,
    swapIntervalMs: map.portalSwapIntervalMs || PORTAL_SWAP_INTERVAL_MS,
  }));
}

function chooseTeleportDestination(map, player, portal, players, now) {
  const others = (players || []).filter((candidate) => candidate.id !== player.id);
  const destination = getLinkedPortal(map, portal);
  if (!destination) return null;
  if (!isValidTeleportPoint(map, destination.x, destination.y, others, now, PLAYER_RADIUS)) return null;
  return destination;
}

function circleRectOverlap(px, py, rect) {
  return (
    px + PLAYER_RADIUS > rect.x &&
    px - PLAYER_RADIUS < rect.x + rect.w &&
    py + PLAYER_RADIUS > rect.y &&
    py - PLAYER_RADIUS < rect.y + rect.h
  );
}

function obstacleOverlap(px, py, obstacle) {
  if (obstacle.shape === 'circle') {
    return Math.hypot(px - obstacle.x, py - obstacle.y) < PLAYER_RADIUS + obstacle.r;
  }
  return circleRectOverlap(px, py, obstacle);
}

function resolveRectCollision(player, wall) {
  const overlapLeft = (player.x + PLAYER_RADIUS) - wall.x;
  const overlapRight = (wall.x + wall.w) - (player.x - PLAYER_RADIUS);
  const overlapTop = (player.y + PLAYER_RADIUS) - wall.y;
  const overlapBottom = (wall.y + wall.h) - (player.y - PLAYER_RADIUS);
  const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

  if (minOverlap === overlapLeft) {
    player.x -= overlapLeft;
    player.vx = Math.min(player.vx, 0);
  } else if (minOverlap === overlapRight) {
    player.x += overlapRight;
    player.vx = Math.max(player.vx, 0);
  } else if (minOverlap === overlapTop) {
    player.y -= overlapTop;
    player.vy = Math.min(player.vy, 0);
  } else {
    player.y += overlapBottom;
    player.vy = Math.max(player.vy, 0);
  }
}

function resolveCircleCollision(player, obstacle) {
  const dx = player.x - obstacle.x;
  const dy = player.y - obstacle.y;
  const distNow = Math.hypot(dx, dy) || 1;
  const minDist = PLAYER_RADIUS + obstacle.r;
  if (distNow >= minDist) return;
  const nx = dx / distNow;
  const ny = dy / distNow;
  const pushOut = minDist - distNow;
  player.x += nx * pushOut;
  player.y += ny * pushOut;
  const dot = player.vx * nx + player.vy * ny;
  if (dot < 0) {
    player.vx -= dot * nx;
    player.vy -= dot * ny;
  }
}

function resolveWallCollision(player, obstacle) {
  if (obstacle.shape === 'circle') {
    resolveCircleCollision(player, obstacle);
    return;
  }
  resolveRectCollision(player, obstacle);
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy || 1;
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / lenSq, 0, 1);
  const cx = x1 + dx * t;
  const cy = y1 + dy * t;
  return {
    distance: Math.hypot(px - cx, py - cy),
    closestX: cx,
    closestY: cy,
  };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function teleportPlayer(map, player, destination) {
  if (!destination) return;

  player.x = destination.x;
  player.y = destination.y;
  player.x = clamp(player.x, PLAYER_RADIUS, MAP_W - PLAYER_RADIUS);
  player.y = clamp(player.y, PLAYER_RADIUS, MAP_H - PLAYER_RADIUS);
  player.vx *= 0.35;
  player.vy *= 0.35;
  player.portalCooldown = PORTAL_COOLDOWN_MS / 1000;
}

function tryProcessPortal(map, player, players, now) {
  if (player.portalCooldown > 0) {
    return null;
  }

  const portal = (map.portals || []).find((candidate) => {
    if (getActivePortalRole(map, candidate, now) !== 'entry') return false;
    return Math.hypot(player.x - candidate.x, player.y - candidate.y) < (map.portalRadius || PORTAL_RADIUS) + PLAYER_RADIUS;
  });

  if (!portal) {
    return null;
  }

  const destination = chooseTeleportDestination(map, player, portal, players, now);
  teleportPlayer(map, player, destination);
  return destination ? { teleported: true, portalId: portal.id, destination } : null;
}

function getRoundMapData(map) {
  return {
    id: map.id,
    width: map.width,
    height: map.height,
    grid: map.grid,
    theme: map.theme,
    frame: map.frame,
    walls: map.walls,
    portals: getPortalState(map, Date.now()),
    portalRadius: map.portalRadius,
    portalCooldownMs: map.portalCooldownMs,
    spawns: map.spawns,
    rotatingBars: map.rotatingBars,
    movingWalls: map.movingWalls,
  };
}

function getFallbackMap() {
  const map = clone(MAP_LIBRARY[0]);
  map.openCells = getAllOpenCells();
  map.portalRadius = PORTAL_RADIUS;
  map.portalCooldownMs = PORTAL_COOLDOWN_MS;
  map.portalSwapStartedAt = Date.now();
  map.portalSwapIntervalMs = PORTAL_SWAP_INTERVAL_MS;
  return map;
}

function eliminatePlayer(room, player, reason) {
  if (!player || !player.alive) return false;
  player.alive = false;
  player.hasBomb = false;

  if (room.bombHolder === player.id) {
    room.bombHolder = null;
    room.bombTimer = BOMB_TIMER_START;
  }

  if (reason === 'lava') {
    io.to(room.id).emit('hazardEliminated', {
      playerId: player.id,
      name: player.name,
      hazard: reason,
    });
  }

  const alive = [...room.players.values()].filter((candidate) => candidate.alive);
  if (alive.length <= 1) {
    endGame(room, alive[0]);
    return true;
  }

  if (!room.bombHolder) {
    const next = alive[randomInt(alive.length)];
    next.hasBomb = true;
    room.bombHolder = next.id;
    room.bombTimer = BOMB_TIMER_START;
    io.to(room.id).emit('bombTransfer', { from: player.id, to: next.id });
  }

  return false;
}

function gameTick(room) {
  const now = Date.now();
  const dt = Math.min((now - room.lastTick) / 1000, 0.05);
  room.lastTick = now;

  const map = room.map || getFallbackMap();
  const activeWalls = getAllWalls(map, now);
  const activeBars = getActiveRotatingBars(map, now);
  const alivePlayers = [...room.players.values()].filter((p) => p.alive);

  for (const player of alivePlayers) {
    if (player.dashCooldown > 0) player.dashCooldown = Math.max(0, player.dashCooldown - dt);
    if (player.passCooldown > 0) player.passCooldown = Math.max(0, player.passCooldown - dt);
    if (player.portalCooldown > 0) player.portalCooldown = Math.max(0, player.portalCooldown - dt);
    if (player.dashActive) {
      player.dashTimer = Math.max(0, player.dashTimer - dt);
      if (player.dashTimer <= 0) player.dashActive = false;
    }

    let inputX = 0;
    let inputY = 0;
    if (!player.dashActive) {
      if (player.inputs.left) inputX -= 1;
      if (player.inputs.right) inputX += 1;
      if (player.inputs.up) inputY -= 1;
      if (player.inputs.down) inputY += 1;

      const inputLength = Math.hypot(inputX, inputY) || 1;
      if (inputX !== 0 || inputY !== 0) {
        inputX /= inputLength;
        inputY /= inputLength;
      }

      if (player.inputs.dash && player.dashCooldown <= 0) {
        player.dashActive = true;
        player.dashTimer = DASH_DURATION;
        player.dashCooldown = DASH_COOLDOWN;
        player.dashDirX = inputX || (Math.random() > 0.5 ? 1 : -1);
        player.dashDirY = inputY;
        player.inputs.dash = false;
      }
    }

    const baseSpeed = player.dashActive ? DASH_SPEED : PLAYER_SPEED;
    const targetVX = (player.dashActive ? player.dashDirX : inputX) * baseSpeed;
    const targetVY = (player.dashActive ? player.dashDirY : inputY) * baseSpeed;

    let control = player.dashActive ? 0.95 : 0.42;
    if (map.theme.id === 'ice' && !player.dashActive) {
      control = inputX === 0 && inputY === 0 ? 0.06 : 0.16;
    }

    player.vx = lerp(player.vx, targetVX, control);
    player.vy = lerp(player.vy, targetVY, control);

    player.x += player.vx * dt;
    player.y += player.vy * dt;

    player.x = clamp(player.x, PLAYER_RADIUS, MAP_W - PLAYER_RADIUS);
    player.y = clamp(player.y, PLAYER_RADIUS, MAP_H - PLAYER_RADIUS);

    for (const wall of activeWalls) {
      if (obstacleOverlap(player.x, player.y, wall)) resolveWallCollision(player, wall);
    }

    for (const bar of activeBars) {
      const half = bar.length / 2;
      const x1 = bar.x + Math.cos(bar.angle) * half;
      const y1 = bar.y + Math.sin(bar.angle) * half;
      const x2 = bar.x - Math.cos(bar.angle) * half;
      const y2 = bar.y - Math.sin(bar.angle) * half;
      const hit = pointToSegmentDistance(player.x, player.y, x1, y1, x2, y2);
      if (hit.distance < PLAYER_RADIUS + bar.thickness / 2) {
        const nx = (player.x - hit.closestX) / (hit.distance || 1);
        const ny = (player.y - hit.closestY) / (hit.distance || 1);
        const pushOut = PLAYER_RADIUS + bar.thickness / 2 - hit.distance;
        player.x += nx * pushOut;
        player.y += ny * pushOut;
        player.vx += nx * bar.push * dt;
        player.vy += ny * bar.push * dt;
      }
    }

    const portalResult = tryProcessPortal(map, player, alivePlayers, now);
    if (portalResult?.teleported) {
      io.to(room.id).emit('portalUsed', {
        playerId: player.id,
        portalId: portalResult.portalId,
        x: portalResult.destination.x,
        y: portalResult.destination.y,
      });
    }

  }

  if (room.bombHolder) {
    room.bombTimer -= dt * 1000;

    if (room.bombTimer <= 0) {
      const victim = room.players.get(room.bombHolder);
      if (victim) {
        victim.alive = false;
        victim.hasBomb = false;
      }
      room.bombHolder = null;
      room.bombTimer = 0;

      io.to(room.id).emit('explosion', { playerId: victim?.id, name: victim?.name });

      const stillAlive = [...room.players.values()].filter((p) => p.alive);
      if (stillAlive.length <= 1) {
        endGame(room, stillAlive[0]);
        return;
      }

      setTimeout(() => {
        if (room.phase !== 'playing') return;
        const alive = [...room.players.values()].filter((p) => p.alive);
        const next = alive[randomInt(alive.length)];
        if (next) {
          next.hasBomb = true;
          room.bombHolder = next.id;
          room.bombTimer = BOMB_TIMER_START;
          io.to(room.id).emit('bombTransfer', { from: null, to: next.id });
        }
      }, 2000);
      return;
    }

    const holder = room.players.get(room.bombHolder);
    if (holder && holder.passCooldown <= 0) {
      for (const player of alivePlayers) {
        if (player.id === room.bombHolder || !player.alive) continue;
        if (dist(holder, player) < PLAYER_RADIUS * 2.2) {
          holder.hasBomb = false;
          holder.passCooldown = PASS_COOLDOWN / 1000;
          player.hasBomb = true;
          player.passCooldown = PASS_COOLDOWN / 1000;
          room.bombHolder = player.id;
          room.bombTimer = BOMB_TIMER_START;
          io.to(room.id).emit('bombTransfer', { from: holder.id, to: player.id });
          break;
        }
      }
    }
  }

  io.to(room.id).emit('gameState', {
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      alive: p.alive,
      hasBomb: p.hasBomb,
      dashActive: p.dashActive,
      color: p.color,
      characterId: p.characterId,
      avatarUrl: p.avatarUrl,
      statusEffects: {
        stunned: false,
        slowed: false,
      },
    })),
    bombTimer: room.bombTimer,
    bombHolder: room.bombHolder,
    portals: getPortalState(map, now),
    rotatingBars: activeBars,
    movingWalls: getActiveMovingWalls(map, now),
    activeEvent: null,
    theme: map.theme.id,
    ts: now,
  });
}

function endGame(room, winner) {
  room.phase = 'gameover';
  clearInterval(room.tickInterval);
  room.tickInterval = null;
  clearCountdown(room);

  if (winner) {
    room.scores[winner.id] = (room.scores[winner.id] || 0) + 1;
  }

  const scoreList = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    score: room.scores[p.id] || 0,
    color: p.color,
    characterId: p.characterId,
    avatarUrl: p.avatarUrl,
  }));

  io.to(room.id).emit('gameOver', {
    winner: winner ? {
      id: winner.id,
      name: winner.name,
      characterId: winner.characterId,
      avatarUrl: winner.avatarUrl,
    } : null,
    scores: scoreList,
  });
}

function startGame(room) {
  room.phase = 'playing';
  room.lastTick = Date.now();
  clearCountdown(room);
  room.map = generateMatchMap(room.players.size);

  let index = 0;
  for (const [, player] of room.players) {
    const spawn = room.map.spawns[index % room.map.spawns.length];
    player.x = spawn.x;
    player.y = spawn.y;
    player.vx = 0;
    player.vy = 0;
    player.alive = true;
    player.hasBomb = false;
    player.dashActive = false;
    player.dashCooldown = 0;
    player.passCooldown = 0;
    player.portalCooldown = 0;
    index++;
  }

  const playerArr = [...room.players.values()];
  const firstHolder = playerArr[randomInt(playerArr.length)];
  firstHolder.hasBomb = true;
  room.bombHolder = firstHolder.id;
  room.bombTimer = BOMB_TIMER_START;

  io.to(room.id).emit('gameStart', {
    mapData: getRoundMapData(room.map),
    firstBombHolder: firstHolder.id,
    scores: room.scores,
  });

  room.tickInterval = setInterval(() => gameTick(room), TICK_MS);
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);
  let currentRoom = null;

  socket.on('createRoom', ({ name }) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const room = createRoom(roomId);
    rooms.set(roomId, room);

    const spawnIdx = room.players.size;
    const player = createPlayer(socket.id, name, spawnIdx);
    room.players.set(socket.id, player);
    room.scores[socket.id] = 0;
    room.hostId = socket.id;

    socket.join(roomId);
    currentRoom = roomId;

    socket.emit('roomCreated', {
      roomId,
      playerId: socket.id,
      hostId: room.hostId,
      players: getPublicPlayers(room),
      mapData: getRoundMapData(room.map || getFallbackMap()),
    });
    emitRoomState(room);
    console.log(`[Room] Created ${roomId} by ${name}`);
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    const normalizedRoomId = String(roomId || '').trim().toUpperCase();
    const room = rooms.get(normalizedRoomId);
    if (!room) {
      socket.emit('roomError', { msg: 'Room not found' });
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('roomError', { msg: 'Game already in progress' });
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      socket.emit('roomError', { msg: 'Room is full' });
      return;
    }

    const spawnIdx = room.players.size;
    const player = createPlayer(socket.id, name, spawnIdx);
    room.players.set(socket.id, player);
    room.scores[socket.id] = 0;

    socket.join(normalizedRoomId);
    currentRoom = normalizedRoomId;

    socket.emit('roomJoined', {
      roomId: currentRoom,
      playerId: socket.id,
      hostId: room.hostId,
      players: getPublicPlayers(room),
      mapData: getRoundMapData(room.map || getFallbackMap()),
    });

    emitRoomState(room);
    console.log(`[Room] ${name} joined ${currentRoom}`);
  });

  socket.on('startGame', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) {
      socket.emit('roomError', { msg: 'Only the host can start the game' });
      return;
    }
    if (room.players.size < MIN_PLAYERS) {
      socket.emit('roomError', { msg: `Need at least ${MIN_PLAYERS} players` });
      return;
    }

    room.phase = 'countdown';
    room.countdown = 3;
    emitRoomState(room);
    io.to(currentRoom).emit('countdown', { value: 3 });
    clearCountdown(room);
    room.countdownInterval = setInterval(() => {
      room.countdown--;
      if (room.countdown <= 0) {
        clearCountdown(room);
        startGame(room);
      } else {
        io.to(currentRoom).emit('countdown', { value: room.countdown });
      }
    }, 1000);
  });

  socket.on('playerInput', (inputs) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;
    player.inputs = { ...player.inputs, ...inputs };
  });

  socket.on('playAgain', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'gameover') return;
    room.phase = 'lobby';
    room.map = null;
    clearCountdown(room);
    io.to(currentRoom).emit('backToLobby', {
      hostId: room.hostId,
      players: getPublicPlayers(room),
    });
    emitRoomState(room);
  });

  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const player = room.players.get(socket.id);
    room.players.delete(socket.id);
    delete room.scores[socket.id];

    if (room.hostId === socket.id) assignNextHost(room);

    if (room.players.size === 0) {
      if (room.tickInterval) clearInterval(room.tickInterval);
      clearCountdown(room);
      rooms.delete(currentRoom);
      console.log(`[Room] Deleted ${currentRoom}`);
      return;
    }

    io.to(currentRoom).emit('playerLeft', { id: socket.id, name: player?.name });
    emitRoomState(room);

    if (room.phase === 'countdown' && room.players.size < MIN_PLAYERS) {
      room.phase = 'lobby';
      clearCountdown(room);
      io.to(currentRoom).emit('countdownCancelled', {
        msg: `Need at least ${MIN_PLAYERS} players to start`,
      });
      emitRoomState(room);
      return;
    }

    if (room.phase === 'playing') {
      if (room.bombHolder === socket.id) {
        const alive = [...room.players.values()].filter((candidate) => candidate.alive);
        if (alive.length === 0) return;
        const next = alive[randomInt(alive.length)];
        next.hasBomb = true;
        room.bombHolder = next.id;
        room.bombTimer = BOMB_TIMER_START;
        io.to(currentRoom).emit('bombTransfer', { from: socket.id, to: next.id });
      }
      const alive = [...room.players.values()].filter((candidate) => candidate.alive);
      if (alive.length <= 1) endGame(room, alive[0]);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Time Bomb Arena server running on http://localhost:${PORT}`);
});
