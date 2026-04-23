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
const LAVA_KILL_SECONDS = 1.4;

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
    hazardExposure: 0,
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

function choosePortalCells(open, spawnCells) {
  const degrees = getCellDegrees(open);
  const spawnKeys = new Set(spawnCells.map((cell) => cellKey(cell.col, cell.row)));
  const candidates = [...open]
    .map(parseCellKey)
    .filter((cell) => !spawnKeys.has(cellKey(cell.col, cell.row)))
    .map((cell) => {
      const minSpawnDistance = Math.min(...spawnCells.map((spawn) => distanceCells(cell, spawn)));
      const edgeBias = Math.min(cell.col, GRID_COLS - 1 - cell.col) + Math.min(cell.row, GRID_ROWS - 1 - cell.row);
      const degree = degrees.get(cellKey(cell.col, cell.row)) || 0;
      return {
        ...cell,
        score: minSpawnDistance * 3 - edgeBias * 1.5 + (degree <= 2 ? 2 : 0),
      };
    })
    .sort((a, b) => b.score - a.score);

  const selected = [];
  for (const candidate of candidates) {
    if (selected.every((picked) => distanceCells(picked, candidate) >= 3)) {
      selected.push(candidate);
    }
    if (selected.length === 3) break;
  }

  while (selected.length < 3 && candidates[selected.length]) {
    selected.push(candidates[selected.length]);
  }
  return selected;
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

function buildWallsFromOpenCells(open) {
  const walls = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (open.has(cellKey(col, row))) continue;
      walls.push({
        x: col * CELL_W + WALL_PADDING,
        y: row * CELL_H + WALL_PADDING,
        w: CELL_W - WALL_PADDING * 2,
        h: CELL_H - WALL_PADDING * 2,
      });
    }
  }
  return walls;
}

function generateThemeFeatures(theme, open, spawnCells) {
  const openCells = [...open]
    .map(parseCellKey)
    .filter((cell) => !spawnCells.some((spawn) => spawn.col === cell.col && spawn.row === cell.row));

  const zones = [];
  const movingWalls = [];
  const candidates = shuffle(openCells);

  if (theme.id === 'forest') {
    for (const cell of candidates.slice(0, 3)) {
      zones.push({ type: 'slow', ...createZoneFromCell(cell, 14), strength: 0.62 });
    }
  }

  if (theme.id === 'lava') {
    for (const cell of candidates.slice(0, 2)) {
      zones.push({ type: 'lava', ...createZoneFromCell(cell, 12), damagePerSecond: 1 / LAVA_KILL_SECONDS });
    }
  }

  if (theme.id === 'industrial') {
    const degrees = getCellDegrees(open);
    const movers = candidates.filter((cell) => (degrees.get(cellKey(cell.col, cell.row)) || 0) >= 2).slice(0, 2);
    movers.forEach((cell, index) => {
      const horizontalNeighbors = open.has(cellKey(cell.col - 1, cell.row)) || open.has(cellKey(cell.col + 1, cell.row));
      movingWalls.push(createMovingWall(cell, horizontalNeighbors ? 'x' : 'y', index));
    });
  }

  return { zones, movingWalls };
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
  const portalCells = choosePortalCells(open, spawnCells);
  const portals = portalCells.map((cell, index) => {
    const world = toWorldPosition(cell);
    const ids = ['A', 'B', 'C'];
    return {
      id: ids[index],
      x: world.x,
      y: world.y,
      pair: ids[(index + 1) % ids.length],
      oneWay: true,
      cooldownMs: PORTAL_COOLDOWN_MS,
    };
  });
  const themeFeatures = generateThemeFeatures(theme, open, spawnCells);

  return {
    width: MAP_W,
    height: MAP_H,
    grid: { cols: GRID_COLS, rows: GRID_ROWS, cellW: CELL_W, cellH: CELL_H },
    theme,
    walls,
    portals,
    portalRadius: PORTAL_RADIUS,
    portalCooldownMs: PORTAL_COOLDOWN_MS,
    spawns: spawnCells.map(toWorldPosition),
    zones: themeFeatures.zones,
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

function getAllWalls(map, now) {
  return [...(map.walls || []), ...getActiveMovingWalls(map, now)];
}

function rectOverlap(px, py, wall) {
  return (
    px + PLAYER_RADIUS > wall.x &&
    px - PLAYER_RADIUS < wall.x + wall.w &&
    py + PLAYER_RADIUS > wall.y &&
    py - PLAYER_RADIUS < wall.y + wall.h
  );
}

function resolveWallCollision(player, wall) {
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

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function getZoneEffects(map, player) {
  const effects = {
    slowFactor: 1,
    inLava: false,
  };

  for (const zone of map.zones || []) {
    if (!pointInRect(player.x, player.y, zone)) continue;
    if (zone.type === 'slow') effects.slowFactor = Math.min(effects.slowFactor, zone.strength || 0.62);
    if (zone.type === 'lava') effects.inLava = true;
  }

  return effects;
}

function getPortalDestination(map, portal) {
  return (map.portals || []).find((candidate) => candidate.id === portal.pair) || null;
}

function teleportPlayer(map, player, portal) {
  const destination = getPortalDestination(map, portal);
  if (!destination) return;

  const momentumLength = Math.hypot(player.vx, player.vy);
  const travelX = destination.x - portal.x;
  const travelY = destination.y - portal.y;
  const travelLength = Math.hypot(travelX, travelY) || 1;
  const dirX = momentumLength > 1 ? player.vx / momentumLength : travelX / travelLength;
  const dirY = momentumLength > 1 ? player.vy / momentumLength : travelY / travelLength;

  player.x = destination.x + dirX * (PORTAL_RADIUS + PLAYER_RADIUS + 6);
  player.y = destination.y + dirY * (PORTAL_RADIUS + PLAYER_RADIUS + 6);
  player.x = clamp(player.x, PLAYER_RADIUS, MAP_W - PLAYER_RADIUS);
  player.y = clamp(player.y, PLAYER_RADIUS, MAP_H - PLAYER_RADIUS);
  player.portalCooldown = (portal.cooldownMs || PORTAL_COOLDOWN_MS) / 1000;
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
    zones: map.zones,
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
  player.hazardExposure = 0;

  if (room.bombHolder === player.id) {
    room.bombHolder = null;
    room.bombTimer = BOMB_TIMER_START;
  }

  if (reason === 'lava') {
    io.to(room.id).emit('hazardEliminated', {
      playerId: player.id,
      name: player.name,
      hazard: 'lava',
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

    const zoneEffects = getZoneEffects(map, player);
    const baseSpeed = player.dashActive ? DASH_SPEED : PLAYER_SPEED * zoneEffects.slowFactor;
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
      if (rectOverlap(player.x, player.y, wall)) resolveWallCollision(player, wall);
    }

    if (player.portalCooldown <= 0) {
      for (const portal of map.portals || []) {
        if (Math.hypot(player.x - portal.x, player.y - portal.y) < (map.portalRadius || PORTAL_RADIUS) + PLAYER_RADIUS) {
          teleportPlayer(map, player, portal);
          break;
        }
      }
    }

    if (zoneEffects.inLava) {
      player.hazardExposure += dt;
      if (player.hazardExposure >= LAVA_KILL_SECONDS) {
        if (eliminatePlayer(room, player, 'lava')) return;
      }
    } else {
      player.hazardExposure = Math.max(0, player.hazardExposure - dt * 1.6);
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
      hazardExposure: p.hazardExposure,
    })),
    bombTimer: room.bombTimer,
    bombHolder: room.bombHolder,
    movingWalls: getActiveMovingWalls(map, now),
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
    player.hazardExposure = 0;
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
