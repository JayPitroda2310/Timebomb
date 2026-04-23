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
const WALL_PADDING = 12;
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
const PORTAL_SPAWN_MIN_MS = 5000;
const PORTAL_SPAWN_MAX_MS = 8000;
const PORTAL_LIFETIME_MIN_MS = 3000;
const PORTAL_LIFETIME_MAX_MS = 6000;
const PORTAL_MAX_ACTIVE_MIN = 2;
const PORTAL_MAX_ACTIVE_MAX = 3;
const EVENT_INTERVAL_MS = 12000;
const EVENT_DURATION_MS = 4500;
const ROTATING_BAR_PUSH = 330;

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

const THEMES = [
  { id: 'forest', name: 'Forest' },
  { id: 'ice', name: 'Ice' },
  { id: 'lava', name: 'Lava' },
  { id: 'industrial', name: 'Industrial' },
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
    events: {
      nextAt: Date.now() + EVENT_INTERVAL_MS,
      active: null,
      triggeredAt: 0,
    },
  };
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function randomRangeInt(min, max) {
  return Math.floor(randomRange(min, max + 1));
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

function cellKey(col, row) {
  return `${col},${row}`;
}

function parseCellKey(key) {
  const [col, row] = key.split(',').map(Number);
  return { col, row };
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

function distanceCells(a, b) {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
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

function carveLine(open, from, to) {
  const current = { ...from };
  open.add(cellKey(current.col, current.row));
  while (current.col !== to.col) {
    current.col += current.col < to.col ? 1 : -1;
    open.add(cellKey(current.col, current.row));
  }
  while (current.row !== to.row) {
    current.row += current.row < to.row ? 1 : -1;
    open.add(cellKey(current.col, current.row));
  }
}

function expandOpenCells(open, iterations) {
  for (let i = 0; i < iterations; i++) {
    const cells = shuffle([...open].map(parseCellKey));
    const cell = cells[0];
    if (!cell) break;
    const neighbors = shuffle([
      { col: cell.col + 1, row: cell.row },
      { col: cell.col - 1, row: cell.row },
      { col: cell.col, row: cell.row + 1 },
      { col: cell.col, row: cell.row - 1 },
    ]).filter((next) => next.col >= 0 && next.col < GRID_COLS && next.row >= 0 && next.row < GRID_ROWS);
    if (neighbors[0]) {
      open.add(cellKey(neighbors[0].col, neighbors[0].row));
    }
    if (neighbors[1] && Math.random() > 0.55) {
      open.add(cellKey(neighbors[1].col, neighbors[1].row));
    }
  }
}

function getCellDegrees(open) {
  const degrees = new Map();
  for (const key of open) {
    const cell = parseCellKey(key);
    let degree = 0;
    const neighbors = [
      cellKey(cell.col + 1, cell.row),
      cellKey(cell.col - 1, cell.row),
      cellKey(cell.col, cell.row + 1),
      cellKey(cell.col, cell.row - 1),
    ];
    for (const nextKey of neighbors) {
      if (open.has(nextKey)) degree++;
    }
    degrees.set(key, degree);
  }
  return degrees;
}

function chooseFeatureCells(open, spawnCells, count, excluded = []) {
  const blocked = new Set([
    ...spawnCells.map((cell) => cellKey(cell.col, cell.row)),
    ...excluded.map((cell) => cellKey(cell.col, cell.row)),
  ]);
  const picked = [];
  for (const cell of shuffle([...open].map(parseCellKey))) {
    const key = cellKey(cell.col, cell.row);
    if (blocked.has(key)) continue;
    if (picked.every((other) => distanceCells(other, cell) >= 2)) {
      picked.push(cell);
      blocked.add(key);
    }
    if (picked.length >= count) break;
  }
  return picked;
}

function createZoneFromCell(cell, inset = 18) {
  return {
    x: cell.col * CELL_W + inset,
    y: cell.row * CELL_H + inset,
    w: CELL_W - inset * 2,
    h: CELL_H - inset * 2,
  };
}

function createMovingWall(cell, axis, index) {
  const center = toWorldPosition(cell);
  const base = axis === 'x'
    ? { x: center.x - 12, y: center.y - 40, w: 24, h: 80 }
    : { x: center.x - 40, y: center.y - 12, w: 80, h: 24 };
  return {
    id: `mover-${index + 1}`,
    axis,
    baseX: base.x,
    baseY: base.y,
    w: base.w,
    h: base.h,
    range: axis === 'x' ? 30 : 26,
    speed: 1.4 + index * 0.25,
    phase: Math.random() * Math.PI * 2,
  };
}

function createPillar(cell) {
  const center = toWorldPosition(cell);
  return {
    shape: 'circle',
    x: center.x,
    y: center.y,
    r: Math.min(CELL_W, CELL_H) * 0.22,
  };
}

function createLaneBar(cell, orientation = 'horizontal', offset = 0) {
  const center = toWorldPosition(cell);
  if (orientation === 'horizontal') {
    return {
      shape: 'rect',
      x: center.x - CELL_W * 0.38,
      y: center.y - 12 + offset,
      w: CELL_W * 0.76,
      h: 24,
    };
  }
  return {
    shape: 'rect',
    x: center.x - 12 + offset,
    y: center.y - CELL_H * 0.38,
    w: 24,
    h: CELL_H * 0.76,
  };
}

function buildWallsFromOpenCells(open) {
  const walls = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (open.has(cellKey(col, row))) continue;
      const leftOpen = open.has(cellKey(col - 1, row));
      const rightOpen = open.has(cellKey(col + 1, row));
      const upOpen = open.has(cellKey(col, row - 1));
      const downOpen = open.has(cellKey(col, row + 1));
      const openCount = [leftOpen, rightOpen, upOpen, downOpen].filter(Boolean).length;

      if (openCount >= 3 || (col + row) % 3 === 0) {
        walls.push(createPillar({ col, row }));
      } else if (leftOpen || rightOpen) {
        walls.push(createLaneBar({ col, row }, 'vertical', (row % 2 === 0 ? -8 : 8)));
      } else if (upOpen || downOpen) {
        walls.push(createLaneBar({ col, row }, 'horizontal', (col % 2 === 0 ? -8 : 8)));
      } else {
        walls.push({
          shape: 'rect',
          x: col * CELL_W + WALL_PADDING + 10,
          y: row * CELL_H + WALL_PADDING + 10,
          w: CELL_W - (WALL_PADDING + 10) * 2,
          h: CELL_H - (WALL_PADDING + 10) * 2,
        });
      }
    }
  }
  return walls;
}

function generateThemeFeatures(theme, open, spawnCells) {
  const openCells = [...open]
    .map(parseCellKey)
    .filter((cell) => !spawnCells.some((spawn) => spawn.col === cell.col && spawn.row === cell.row));

  const movingWalls = [];
  const rotatingBars = [];
  const candidates = shuffle(openCells);

  if (theme.id === 'industrial') {
    const degrees = getCellDegrees(open);
    const movers = candidates.filter((cell) => (degrees.get(cellKey(cell.col, cell.row)) || 0) >= 2).slice(0, 2);
    movers.forEach((cell, index) => {
      const horizontalNeighbors = open.has(cellKey(cell.col - 1, cell.row)) || open.has(cellKey(cell.col + 1, cell.row));
      movingWalls.push(createMovingWall(cell, horizontalNeighbors ? 'x' : 'y', index));
    });
  }

  const rotatingCells = chooseFeatureCells(open, spawnCells, 2);
  rotatingCells.forEach((cell, index) => {
    const center = toWorldPosition(cell);
    rotatingBars.push({
      id: `rotor-${index + 1}`,
      x: center.x,
      y: center.y,
      length: 96 + index * 12,
      thickness: 16,
      angularSpeed: 1.1 + index * 0.35,
      angle: Math.random() * Math.PI,
      push: ROTATING_BAR_PUSH,
    });
  });

  return { movingWalls, rotatingBars };
}

function generateMatchMap(playerCount) {
  const theme = choice(THEMES);
  const spawnCells = DEFAULT_SPAWN_CELLS.slice(0, playerCount);
  const open = new Set(spawnCells.map((cell) => cellKey(cell.col, cell.row)));

  const route = shuffle(spawnCells);
  for (let i = 1; i < route.length; i++) {
    carveLine(open, route[i - 1], route[i]);
  }
  carveLine(open, { col: 0, row: 2 }, { col: 8, row: 2 });
  carveLine(open, { col: 2, row: 0 }, { col: 2, row: 5 });
  carveLine(open, { col: 6, row: 0 }, { col: 6, row: 5 });
  expandOpenCells(open, 16);

  const walls = buildWallsFromOpenCells(open);
  const themeFeatures = generateThemeFeatures(theme, open, spawnCells);
  const now = Date.now();

  return {
    width: MAP_W,
    height: MAP_H,
    grid: { cols: GRID_COLS, rows: GRID_ROWS, cellW: CELL_W, cellH: CELL_H },
    theme,
    walls,
    openCells: [...open].map(parseCellKey),
    portals: [],
    portalRadius: PORTAL_RADIUS,
    portalCooldownMs: PORTAL_COOLDOWN_MS,
    portalSpawn: {
      nextAt: now + randomRangeInt(PORTAL_SPAWN_MIN_MS, PORTAL_SPAWN_MAX_MS),
      maxActive: randomRangeInt(PORTAL_MAX_ACTIVE_MIN, PORTAL_MAX_ACTIVE_MAX),
      sequence: 0,
    },
    spawns: spawnCells.map(toWorldPosition),
    rotatingBars: themeFeatures.rotatingBars,
    movingWalls: themeFeatures.movingWalls,
  };
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

function scheduleNextPortal(map, now) {
  map.portalSpawn.nextAt = now + randomRangeInt(PORTAL_SPAWN_MIN_MS, PORTAL_SPAWN_MAX_MS);
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

function getRiskScore(map, point, activeWalls) {
  const edgeDistance = Math.min(point.x, MAP_W - point.x, point.y, MAP_H - point.y);
  let score = (Math.max(MAP_W, MAP_H) - edgeDistance) * 0.012;

  for (const wall of activeWalls) {
    const cx = wall.shape === 'circle' ? wall.x : wall.x + wall.w / 2;
    const cy = wall.shape === 'circle' ? wall.y : wall.y + wall.h / 2;
    const distance = Math.hypot(point.x - cx, point.y - cy);
    if (distance < 180) score += (180 - distance) / 45;
  }

  for (const bar of map.rotatingBars || []) {
    const distance = Math.hypot(point.x - bar.x, point.y - bar.y);
    if (distance < 180) score += (180 - distance) / 38;
  }

  for (const wall of map.movingWalls || []) {
    const cx = wall.baseX + wall.w / 2;
    const cy = wall.baseY + wall.h / 2;
    const distance = Math.hypot(point.x - cx, point.y - cy);
    if (distance < 180) score += (180 - distance) / 42;
  }

  return score + Math.random() * 1.75;
}

function isValidTeleportPoint(map, x, y, players, now, radius = PLAYER_RADIUS) {
  if (x < radius || x > MAP_W - radius || y < radius || y > MAP_H - radius) return false;
  const activeWalls = getAllWalls(map, now);
  if (activeWalls.some((wall) => circleOverlapsObstacle(x, y, radius, wall))) return false;
  if ((map.rotatingBars || []).some((bar) => circleOverlapsBar(x, y, radius + 8, bar, now))) return false;
  if ((players || []).some((player) => player.alive && Math.hypot(player.x - x, player.y - y) < radius + PLAYER_RADIUS + 18)) return false;
  return true;
}

function getRandomPointInCell(cell, margin = 24) {
  return {
    x: cell.col * CELL_W + randomRange(margin, CELL_W - margin),
    y: cell.row * CELL_H + randomRange(margin, CELL_H - margin),
  };
}

function choosePortalSpawnPosition(map, players, now) {
  const activeWalls = getAllWalls(map, now);
  const candidates = [];
  for (const cell of shuffle(map.openCells || [])) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const point = getRandomPointInCell(cell, PORTAL_RADIUS + 6);
      if (!isValidTeleportPoint(map, point.x, point.y, players, now, PORTAL_RADIUS)) continue;
      candidates.push({
        ...point,
        score: getRiskScore(map, point, activeWalls),
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function chooseTeleportDestination(map, player, players, now) {
  const others = (players || []).filter((candidate) => candidate.id !== player.id);
  for (let attempt = 0; attempt < 80; attempt++) {
    const cell = choice(map.openCells || []);
    if (!cell) break;
    const point = getRandomPointInCell(cell, PLAYER_RADIUS + 8);
    if (isValidTeleportPoint(map, point.x, point.y, others, now, PLAYER_RADIUS)) return point;
  }
  return null;
}

function updateDynamicPortals(room, now) {
  const map = room.map;
  if (!map) return;
  if (!map.portalSpawn) {
    map.portalSpawn = {
      nextAt: now + randomRangeInt(PORTAL_SPAWN_MIN_MS, PORTAL_SPAWN_MAX_MS),
      maxActive: randomRangeInt(PORTAL_MAX_ACTIVE_MIN, PORTAL_MAX_ACTIVE_MAX),
      sequence: 0,
    };
  }

  const beforeIds = new Set((map.portals || []).map((portal) => portal.id));
  map.portals = (map.portals || []).filter((portal) => now < portal.expiresAt);

  if (now < map.portalSpawn.nextAt || map.portals.length >= map.portalSpawn.maxActive) return;

  const alivePlayers = [...room.players.values()].filter((player) => player.alive);
  const position = choosePortalSpawnPosition(map, alivePlayers, now);
  scheduleNextPortal(map, now);
  if (!position) return;

  const lifetimeMs = randomRangeInt(PORTAL_LIFETIME_MIN_MS, PORTAL_LIFETIME_MAX_MS);
  map.portalSpawn.sequence += 1;
  const portal = {
    id: `RIFT-${map.portalSpawn.sequence}`,
    kind: 'random',
    x: position.x,
    y: position.y,
    spawnedAt: now,
    expiresAt: now + lifetimeMs,
    lifetimeMs,
  };
  map.portals.push(portal);

  if (!beforeIds.has(portal.id)) {
    io.to(room.id).emit('portalSpawned', { portal });
  }
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

function createEventZone(type) {
  const col = 2 + randomInt(Math.max(1, GRID_COLS - 4));
  const row = 1 + randomInt(Math.max(1, GRID_ROWS - 2));
  return {
    type,
    ...createZoneFromCell({ col, row }, 14),
  };
}

function triggerRoundEvent(room, now) {
  const eventType = 'danger';
  room.events.active = {
    type: eventType,
    startedAt: now,
    endsAt: now + EVENT_DURATION_MS,
    zone: createEventZone(eventType),
  };
  room.events.triggeredAt = now;
  room.events.nextAt = now + EVENT_INTERVAL_MS + randomInt(2500);

  io.to(room.id).emit('mapEvent', {
    type: eventType,
    zone: room.events.active.zone,
    durationMs: EVENT_DURATION_MS,
  });
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
    return Math.hypot(player.x - candidate.x, player.y - candidate.y) < (map.portalRadius || PORTAL_RADIUS) + PLAYER_RADIUS;
  });

  if (!portal) {
    return null;
  }

  const destination = chooseTeleportDestination(map, player, players, now);
  teleportPlayer(map, player, destination);
  return destination ? { teleported: true, portalId: portal.id, destination } : null;
}

function getRoundMapData(map) {
  return {
    width: map.width,
    height: map.height,
    grid: map.grid,
    theme: map.theme,
    walls: map.walls,
    portals: map.portals,
    portalRadius: map.portalRadius,
    portalCooldownMs: map.portalCooldownMs,
    spawns: map.spawns,
    rotatingBars: map.rotatingBars,
    movingWalls: map.movingWalls,
  };
}

function getFallbackMap() {
  return generateMatchMap(MAX_PLAYERS);
}

function eliminatePlayer(room, player, reason) {
  if (!player || !player.alive) return false;
  player.alive = false;
  player.hasBomb = false;

  if (room.bombHolder === player.id) {
    room.bombHolder = null;
    room.bombTimer = BOMB_TIMER_START;
  }

  if (reason === 'lava' || reason === 'danger') {
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
  updateDynamicPortals(room, now);
  const activeWalls = getAllWalls(map, now);
  const activeBars = getActiveRotatingBars(map, now);
  const alivePlayers = [...room.players.values()].filter((p) => p.alive);

  if (!room.events.active && now >= room.events.nextAt) {
    triggerRoundEvent(room, now);
  }
  if (room.events.active && now >= room.events.active.endsAt) {
    room.events.active = null;
  }

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

    if (room.events.active?.zone && pointInRect(player.x, player.y, room.events.active.zone)) {
      if (room.events.active.type === 'danger') {
        if (eliminatePlayer(room, player, 'danger')) return;
      }
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
    portals: map.portals,
    rotatingBars: activeBars,
    movingWalls: getActiveMovingWalls(map, now),
    activeEvent: room.events.active,
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
  room.events = {
    nextAt: Date.now() + EVENT_INTERVAL_MS,
    active: null,
    triggeredAt: 0,
  };

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
