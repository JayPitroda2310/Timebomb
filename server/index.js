const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000,
  pingTimeout: 5000
});

// Serve client files
app.use(express.static(path.join(__dirname, '../client')));
app.use('/characters', express.static(path.join(__dirname, '../characters')));
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const TICK_RATE        = 60;   // server ticks per second
const TICK_MS          = 1000 / TICK_RATE;
const MAP_W            = 900;
const MAP_H            = 600;
const PLAYER_RADIUS    = 18;
const PLAYER_SPEED     = 220; // px/s
const DASH_SPEED       = 650;
const DASH_DURATION    = 0.18; // seconds
const DASH_COOLDOWN    = 1.2;
const BOMB_TIMER_START = 60000; // ms
const PASS_COOLDOWN    = 1000; // ms
const MIN_PLAYERS      = 2;
const MAX_PLAYERS      = 6;

// ─── MAP DATA ─────────────────────────────────────────────────────────────────
// Walls: { x, y, w, h }
const WALLS = [
  // Border walls (invisible - handled by boundary clamp)
  // Interior obstacles
  { x: 180, y: 100, w: 80,  h: 200 },
  { x: 640, y: 100, w: 80,  h: 200 },
  { x: 180, y: 300, w: 80,  h: 200 },
  { x: 640, y: 300, w: 80,  h: 200 },
  { x: 370, y: 160, w: 160, h: 60  },
  { x: 370, y: 380, w: 160, h: 60  },
  { x: 410, y: 260, w: 80,  h: 80  },
];

// Portals: pairs [{ x, y, id }, { x, y, id }]
const PORTALS = [
  { id: 'A1', x: 50,  y: 50,  pair: 'A2' },
  { id: 'A2', x: 840, y: 540, pair: 'A1' },
  { id: 'B1', x: 50,  y: 540, pair: 'B2' },
  { id: 'B2', x: 840, y: 50,  pair: 'B1' },
];
const PORTAL_RADIUS  = 20;
const PORTAL_COOLDOWN = 1500;

// Spawn points
const SPAWNS = [
  { x: 100, y: 300 }, { x: 800, y: 300 },
  { x: 450, y: 80  }, { x: 450, y: 520 },
  { x: 100, y: 100 }, { x: 800, y: 500 },
];

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

// ─── ROOMS ───────────────────────────────────────────────────────────────────
const rooms = new Map(); // roomId -> RoomState

function createRoom(roomId) {
  return {
    id: roomId,
    players: new Map(),  // socketId -> playerState
    hostId: null,
    phase: 'lobby',      // lobby | countdown | playing | gameover
    bombHolder: null,
    bombTimer: BOMB_TIMER_START,
    lastTick: Date.now(),
    tickInterval: null,
    countdown: 3,
    countdownInterval: null,
    roundWinner: null,
    scores: {},          // socketId -> wins
  };
}

function getPublicPlayers(room) {
  return [...room.players.values()].map(p => ({
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

function createPlayer(socketId, name, spawnIndex) {
  const spawn = SPAWNS[spawnIndex % SPAWNS.length];
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
    color: ['#FF4444','#44AAFF','#44FF88','#FFBB44','#FF44FF','#44FFFF'][spawnIndex % 6],
    characterId: character.id,
    avatarUrl: character.avatarUrl,
  };
}

// ─── PHYSICS ─────────────────────────────────────────────────────────────────
function rectOverlap(px, py, wall) {
  return (
    px + PLAYER_RADIUS > wall.x &&
    px - PLAYER_RADIUS < wall.x + wall.w &&
    py + PLAYER_RADIUS > wall.y &&
    py - PLAYER_RADIUS < wall.y + wall.h
  );
}

function resolveWallCollision(p, wall) {
  const overlapLeft   = (p.x + PLAYER_RADIUS) - wall.x;
  const overlapRight  = (wall.x + wall.w) - (p.x - PLAYER_RADIUS);
  const overlapTop    = (p.y + PLAYER_RADIUS) - wall.y;
  const overlapBottom = (wall.y + wall.h) - (p.y - PLAYER_RADIUS);
  const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);
  if (minOverlap === overlapLeft)   { p.x -= overlapLeft;   p.vx = Math.min(p.vx, 0); }
  else if (minOverlap === overlapRight)  { p.x += overlapRight;  p.vx = Math.max(p.vx, 0); }
  else if (minOverlap === overlapTop)    { p.y -= overlapTop;    p.vy = Math.min(p.vy, 0); }
  else                              { p.y += overlapBottom; p.vy = Math.max(p.vy, 0); }
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ─── GAME TICK ────────────────────────────────────────────────────────────────
function gameTick(room) {
  const now = Date.now();
  const dt  = Math.min((now - room.lastTick) / 1000, 0.05);
  room.lastTick = now;

  const alivePlayers = [...room.players.values()].filter(p => p.alive);

  // ── Move players
  for (const p of alivePlayers) {
    // Cooldowns
    if (p.dashCooldown > 0)  p.dashCooldown  = Math.max(0, p.dashCooldown  - dt);
    if (p.passCooldown > 0)  p.passCooldown  = Math.max(0, p.passCooldown  - dt);
    if (p.portalCooldown > 0) p.portalCooldown = Math.max(0, p.portalCooldown - dt);

    if (p.dashActive) {
      p.dashTimer = Math.max(0, p.dashTimer - dt);
      if (p.dashTimer <= 0) p.dashActive = false;
    }

    let ax = 0, ay = 0;
    if (!p.dashActive) {
      if (p.inputs.left)  ax -= 1;
      if (p.inputs.right) ax += 1;
      if (p.inputs.up)    ay -= 1;
      if (p.inputs.down)  ay += 1;
      const len = Math.hypot(ax, ay) || 1;
      if (ax !== 0 || ay !== 0) { ax /= len; ay /= len; }

      // Trigger dash
      if (p.inputs.dash && p.dashCooldown <= 0) {
        p.dashActive   = true;
        p.dashTimer    = DASH_DURATION;
        p.dashCooldown = DASH_COOLDOWN;
        p.dashDirX     = ax || (Math.random() > 0.5 ? 1 : -1);
        p.dashDirY     = ay;
        p.inputs.dash  = false;
      }
    }

    let speed;
    if (p.dashActive) {
      speed = DASH_SPEED;
      ax = p.dashDirX;
      ay = p.dashDirY;
    } else {
      speed = PLAYER_SPEED;
    }

    p.vx = ax * speed;
    p.vy = ay * speed;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Boundary
    p.x = Math.max(PLAYER_RADIUS, Math.min(MAP_W - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(MAP_H - PLAYER_RADIUS, p.y));

    // Wall collisions
    for (const wall of WALLS) {
      if (rectOverlap(p.x, p.y, wall)) resolveWallCollision(p, wall);
    }

    // Portal teleport
    if (p.portalCooldown <= 0) {
      for (const portal of PORTALS) {
        if (Math.hypot(p.x - portal.x, p.y - portal.y) < PORTAL_RADIUS + PLAYER_RADIUS) {
          const dest = PORTALS.find(q => q.id === portal.pair);
          if (dest) {
            p.x = dest.x;
            p.y = dest.y;
            p.portalCooldown = PORTAL_COOLDOWN / 1000;
          }
          break;
        }
      }
    }
  }

  // ── Bomb countdown
  if (room.bombHolder) {
    room.bombTimer -= dt * 1000;

    if (room.bombTimer <= 0) {
      // EXPLOSION
      const victim = room.players.get(room.bombHolder);
      if (victim) {
        victim.alive  = false;
        victim.hasBomb = false;
      }
      room.bombHolder = null;
      room.bombTimer  = 0;

      io.to(room.id).emit('explosion', { playerId: victim?.id, name: victim?.name });

      const stillAlive = [...room.players.values()].filter(p => p.alive);
      if (stillAlive.length <= 1) {
        endGame(room, stillAlive[0]);
        return;
      }

      // Give bomb to random alive player with delay
      setTimeout(() => {
        if (room.phase !== 'playing') return;
        const alive = [...room.players.values()].filter(p => p.alive);
        const next  = alive[Math.floor(Math.random() * alive.length)];
        if (next) {
          next.hasBomb       = true;
          room.bombHolder    = next.id;
          room.bombTimer     = BOMB_TIMER_START;
          io.to(room.id).emit('bombTransfer', { from: null, to: next.id });
        }
      }, 2000);
      return;
    }

    // ── Bomb passing (proximity)
    const holder = room.players.get(room.bombHolder);
    if (holder && holder.passCooldown <= 0) {
      for (const p of alivePlayers) {
        if (p.id === room.bombHolder) continue;
        if (dist(holder, p) < PLAYER_RADIUS * 2.2) {
          // Transfer bomb
          holder.hasBomb  = false;
          holder.passCooldown = PASS_COOLDOWN / 1000;
          p.hasBomb       = true;
          p.passCooldown  = PASS_COOLDOWN / 1000;
          room.bombHolder = p.id;
          room.bombTimer  = BOMB_TIMER_START;
          io.to(room.id).emit('bombTransfer', { from: holder.id, to: p.id });
          break;
        }
      }
    }
  }

  // ── Broadcast state
  const state = {
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y,
      alive: p.alive, hasBomb: p.hasBomb,
      dashActive: p.dashActive, color: p.color,
      characterId: p.characterId, avatarUrl: p.avatarUrl,
    })),
    bombTimer: room.bombTimer,
    bombHolder: room.bombHolder,
    ts: now,
  };
  io.to(room.id).emit('gameState', state);
}

function endGame(room, winner) {
  room.phase = 'gameover';
  clearInterval(room.tickInterval);
  room.tickInterval = null;
  clearCountdown(room);

  if (winner) {
    room.scores[winner.id] = (room.scores[winner.id] || 0) + 1;
  }

  const scoreList = [...room.players.values()].map(p => ({
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
  room.phase  = 'playing';
  room.lastTick = Date.now();
  clearCountdown(room);

  // Reset players
  let idx = 0;
  for (const [, p] of room.players) {
    const spawn = SPAWNS[idx % SPAWNS.length];
    p.x = spawn.x; p.y = spawn.y;
    p.vx = 0; p.vy = 0;
    p.alive = true; p.hasBomb = false;
    p.dashActive = false; p.dashCooldown = 0;
    p.passCooldown = 0; p.portalCooldown = 0;
    idx++;
  }

  // Random first bomb holder
  const playerArr = [...room.players.values()];
  const firstHolder = playerArr[Math.floor(Math.random() * playerArr.length)];
  firstHolder.hasBomb = true;
  room.bombHolder = firstHolder.id;
  room.bombTimer  = BOMB_TIMER_START;

  io.to(room.id).emit('gameStart', {
    mapData: { walls: WALLS, portals: PORTALS, width: MAP_W, height: MAP_H },
    firstBombHolder: firstHolder.id,
    scores: room.scores,
  });

  room.tickInterval = setInterval(() => gameTick(room), TICK_MS);
}

// ─── SOCKET EVENTS ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);
  let currentRoom = null;

  socket.on('createRoom', ({ name }) => {
    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
    const room   = createRoom(roomId);
    rooms.set(roomId, room);

    const spawnIdx = room.players.size;
    const player   = createPlayer(socket.id, name, spawnIdx);
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
      mapData: { walls: WALLS, portals: PORTALS, width: MAP_W, height: MAP_H },
    });
    emitRoomState(room);
    console.log(`[Room] Created ${roomId} by ${name}`);
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    const normalizedRoomId = String(roomId || '').trim().toUpperCase();
    const room = rooms.get(normalizedRoomId);
    if (!room) { socket.emit('roomError', { msg: 'Room not found' }); return; }
    if (room.phase !== 'lobby') { socket.emit('roomError', { msg: 'Game already in progress' }); return; }
    if (room.players.size >= MAX_PLAYERS) { socket.emit('roomError', { msg: 'Room is full' }); return; }

    const spawnIdx = room.players.size;
    const player   = createPlayer(socket.id, name, spawnIdx);
    room.players.set(socket.id, player);
    room.scores[socket.id] = 0;

    socket.join(normalizedRoomId);
    currentRoom = normalizedRoomId;

    const playerList = [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      characterId: p.characterId,
      avatarUrl: p.avatarUrl,
    }));

    socket.emit('roomJoined', {
      roomId: currentRoom,
      playerId: socket.id,
      hostId: room.hostId,
      players: playerList,
      mapData: { walls: WALLS, portals: PORTALS, width: MAP_W, height: MAP_H },
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
    // Countdown
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

    if (room.hostId === socket.id) {
      assignNextHost(room);
    }

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
      // If bomb holder disconnected, give bomb to someone else
      if (room.bombHolder === socket.id) {
        const alive = [...room.players.values()].filter(p => p.alive);
        if (alive.length === 0) return;
        const next = alive[Math.floor(Math.random() * alive.length)];
        next.hasBomb    = true;
        room.bombHolder = next.id;
        room.bombTimer  = BOMB_TIMER_START;
        io.to(currentRoom).emit('bombTransfer', { from: socket.id, to: next.id });
      }
      const alive = [...room.players.values()].filter(p => p.alive);
      if (alive.length <= 1) endGame(room, alive[0]);
    }
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 Time Bomb Arena server running on http://localhost:${PORT}\n`);
});
