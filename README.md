# 💣 Time Bomb Arena

A fast-paced real-time multiplayer browser game. Pass the ticking bomb — last one standing wins!

---

## 📁 Project Structure

```
time-bomb-arena/
├── server/
│   ├── index.js          ← Node.js + Express + Socket.io game server
│   └── package.json
└── client/
    ├── index.html        ← Game UI & screens
    ├── style.css         ← Styling (Black Ops One + Rajdhani fonts)
    └── game.js           ← Phaser 3 game engine + socket client
```

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start the server

```bash
npm start
# or for auto-reload during dev:
npm run dev
```

You should see:
```
🎮 Time Bomb Arena server running on http://localhost:3000
```

### 3. Open the game

Open your browser and go to: **http://localhost:3000**

---

## 🧪 Testing Multiplayer Locally

**Method A — Two browser windows (easiest):**
1. Open `http://localhost:3000` in Window 1
2. Open `http://localhost:3000` in Window 2 (or use Incognito)
3. In Window 1: Enter a name → **Create Room** → note the 6-letter code
4. In Window 2: Enter a name → **Join Room** → enter the code → Join
5. Back in Window 1 (host): Click **Start Game**

**Method B — Two machines on same network:**
1. Find your local IP: `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
2. Start the server on your machine
3. On both machines, open `http://YOUR_LOCAL_IP:3000`
4. Follow same room creation steps

---

## 🎮 Controls

| Action | Keys |
|--------|------|
| Move   | WASD or Arrow Keys |
| Dash   | Spacebar |

**Bomb rules:**
- Walk into another player to pass the bomb
- Timer resets on each pass (8 seconds)
- 1-second cooldown after passing (no instant re-pass)
- When timer hits zero → 💥 explosion → player eliminated
- Last alive player wins!

---

## 🗺️ Map Features

- **Walls** — blocky obstacles that force close encounters
- **Teleport Portals** — 4 portals in corners (A↔A, B↔B pairs)
- Arena size: 900×600px

---

## ⚙️ Configuration (server/index.js)

```js
const BOMB_TIMER_START = 8000;   // ms before explosion
const PLAYER_SPEED     = 220;    // pixels/second
const DASH_SPEED       = 650;    // pixels/second during dash
const DASH_DURATION    = 0.18;   // seconds
const DASH_COOLDOWN    = 1.2;    // seconds
const PASS_COOLDOWN    = 1000;   // ms cooldown after passing bomb
const MIN_PLAYERS      = 2;      // minimum to start game
const MAX_PLAYERS      = 6;      // max per room
```

---

## 🌐 Deploying to Production

1. Set `PORT` environment variable (e.g. `PORT=8080`)
2. Deploy the entire `time-bomb-arena/` folder
3. The server serves `client/` as static files
4. Socket.io handles WebSocket upgrade automatically

**Example (Railway / Render / Heroku):**
```bash
npm start
```

Most Node hosts can run this repo directly from the project root now:

- Build command: `npm install`
- Start command: `npm start`

Health check endpoint:

- `GET /health`

### Vercel

Vercel can host the static frontend in `client/`, but the current `server/index.js` is a long-running Socket.IO server and is not a good fit for Vercel's serverless model.

- Frontend: deploy this repo to Vercel with `vercel.json` pointing `outputDirectory` to `client`
- Backend: deploy `server/` on a Node host such as Render, Railway, or Heroku-style hosting
- Connect frontend to backend by opening the Vercel URL with `?server=https://your-backend-url`

Example:

```text
https://your-vercel-app.vercel.app/?server=https://your-backend.onrender.com
```

---

## 🔊 Audio

All audio is generated procedurally via the Web Audio API — no files needed:
- **Tick sound** — speeds up as bomb timer decreases
- **Explosion** — noise burst + low thud
- **Bomb transfer** — rising sawtooth blip

Audio activates on first user interaction (browser policy).

---

## 🏗️ Architecture

```
Browser (Phaser 3)              Node.js Server
──────────────────              ──────────────
playerInput ──────────────────► process inputs
                                run physics (60 ticks/s)
                                detect collisions
                                manage bomb timer
gameState ◄──────────────────── broadcast state
bombTransfer ◄───────────────── broadcast event
explosion ◄──────────────────── broadcast event
```

**Server-authoritative:** All game logic runs on the server. The client renders whatever the server says. Player inputs are sent up, processed server-side, and the resulting game state is broadcast to all clients at 60 Hz.
