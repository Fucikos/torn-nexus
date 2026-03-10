# TORN NEXUS — Underground Betting Exchange

> A fan-made, server-backed betting platform for Torn City players.
> Uses the Torn API to verify identities and balances. All currency is **Torn in-game dollars ($)** — no real money involved.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Database Schema](#database-schema)
- [API Endpoints](#api-endpoints)
- [Torn API Integration](#torn-api-integration)
- [Deposit & Withdrawal Flow](#deposit--withdrawal-flow)
- [Game Logic](#game-logic)
- [Environment Variables](#environment-variables)
- [Setup & Installation](#setup--installation)
- [Security Considerations](#security-considerations)
- [Torn ToS Compliance](#torn-tos-compliance)

---

## Overview

Torn Nexus is a crash-style betting game where players wager Torn City in-game dollars. A multiplier climbs from 1.00× and crashes at a random point each round — cash out before the crash to win, miss it and lose your bet.

**Key principles:**
- The **house account** (a Torn player you control) sends and receives in-game money to/from players
- The server verifies all transactions via the **Torn API** before crediting or debiting any balance
- Player API keys are stored server-side only, never exposed to the client
- All balances, transactions, and game history are persisted in a **PostgreSQL** database

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     BROWSER (Client)                    │
│  index.html + main.js + styles.css                      │
│  - No API keys ever stored or exposed here              │
│  - Communicates only with YOUR backend via REST         │
└───────────────────────┬─────────────────────────────────┘
                        │  HTTPS REST API
┌───────────────────────▼─────────────────────────────────┐
│                  NODE.JS BACKEND SERVER                  │
│  Express.js + JWT sessions                              │
│  - Holds house account API key in environment variable  │
│  - Validates all Torn API calls server-side             │
│  - Runs game loop (crash point generation)              │
│  - Manages wallet ledger                                │
└──────────┬────────────────────────┬─────────────────────┘
           │                        │
┌──────────▼──────────┐  ┌─────────▼──────────────────────┐
│   PostgreSQL DB      │  │       TORN API                 │
│   - users            │  │  api.torn.com                  │
│   - wallets          │  │  - Verify player identity      │
│   - transactions     │  │  - Check transaction logs      │
│   - rounds           │  │  - Confirm money received      │
│   - bets             │  └────────────────────────────────┘
└─────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (existing) |
| Backend | Node.js + Express.js |
| Database | PostgreSQL |
| ORM | Prisma (or pg directly) |
| Auth | JWT (JSON Web Tokens) |
| Torn Integration | Torn REST API v2 |
| Session store | express-session + connect-pg-simple |
| Environment | dotenv |
| Optional deployment | Railway / Render / VPS |

---

## Project Structure

```
torn-nexus/
├── client/
│   ├── index.html
│   ├── main.js
│   └── styles.css
│
├── server/
│   ├── index.js              # Express entry point
│   ├── config/
│   │   └── db.js             # PostgreSQL connection
│   ├── middleware/
│   │   ├── auth.js           # JWT verification middleware
│   │   └── rateLimit.js      # Per-IP rate limiting
│   ├── routes/
│   │   ├── auth.js           # POST /api/auth/login, /logout
│   │   ├── wallet.js         # GET/POST /api/wallet/...
│   │   └── game.js           # GET/POST /api/game/...
│   ├── services/
│   │   ├── tornApi.js        # All Torn API calls (server-side only)
│   │   ├── gameLoop.js       # Crash game engine
│   │   └── ledger.js         # Balance mutation + transaction logging
│   └── utils/
│       └── crashPoint.js     # Provably fair crash generation
│
├── prisma/
│   └── schema.prisma         # DB schema
│
├── .env                      # Secret config (never commit this)
├── .env.example              # Template for setup
├── package.json
└── README.md
```

---

## Database Schema

```sql
-- Users: one row per Torn player who has logged in
CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  torn_id         INTEGER UNIQUE NOT NULL,     -- Torn player_id
  username        VARCHAR(64) UNIQUE NOT NULL,
  encrypted_key   TEXT NOT NULL,               -- Player's LIMITED access API key, AES-256 encrypted
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_seen       TIMESTAMPTZ DEFAULT NOW()
);

-- Wallets: one balance row per user
CREATE TABLE wallets (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER UNIQUE REFERENCES users(id),
  balance          BIGINT DEFAULT 0,           -- in Torn $ (integer cents avoid float bugs)
  total_deposited  BIGINT DEFAULT 0,
  total_withdrawn  BIGINT DEFAULT 0,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Transactions: full ledger — every credit and debit
CREATE TABLE transactions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id),
  type         VARCHAR(16) NOT NULL,           -- 'deposit' | 'withdrawal' | 'bet_win' | 'bet_loss'
  amount       BIGINT NOT NULL,                -- always positive; direction implied by type
  description  TEXT,
  torn_tx_id   INTEGER,                        -- Torn transaction ID for deposits/withdrawals
  round_id     INTEGER,                        -- game round reference for bets
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Rounds: one row per completed crash round
CREATE TABLE rounds (
  id           SERIAL PRIMARY KEY,
  crash_point  NUMERIC(10,2) NOT NULL,
  seed         TEXT NOT NULL,                  -- for provably fair verification
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  ended_at     TIMESTAMPTZ
);

-- Bets: one row per player bet per round
CREATE TABLE bets (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id),
  round_id      INTEGER REFERENCES rounds(id),
  amount        BIGINT NOT NULL,
  cashout_mult  NUMERIC(10,2),                 -- NULL = busted
  payout        BIGINT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

---

## API Endpoints

### Auth

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Verify player via Torn API, issue JWT |
| `POST` | `/api/auth/logout` | Invalidate session |
| `GET` | `/api/auth/me` | Return current user info |

**POST /api/auth/login — request body:**
```json
{
  "username": "Fucikos",
  "apiKey": "player_limited_access_key_here"
}
```

**What the server does:**
1. Calls `api.torn.com/user/?selections=basic&key={apiKey}` server-side
2. Verifies the returned `name` matches the submitted `username`
3. Stores the encrypted API key in the `users` table
4. Issues a signed JWT — the API key is **never sent back to the client**

---

### Wallet

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/wallet` | Get current balance + recent transactions |
| `POST` | `/api/wallet/deposit` | Verify a Torn transaction and credit balance |
| `POST` | `/api/wallet/withdraw` | Debit balance and record pending withdrawal |
| `GET` | `/api/wallet/transactions` | Paginated transaction history |

**POST /api/wallet/deposit — request body:**
```json
{
  "amount": 100000,
  "tornTxId": 987654321
}
```

**What the server does — see full flow below.**

---

### Game

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/game/state` | Current round phase, multiplier, active players |
| `POST` | `/api/game/bet` | Place a bet for the current round |
| `POST` | `/api/game/cashout` | Cash out at current multiplier |
| `GET` | `/api/game/history` | Last N completed rounds |
| `GET` | `/api/game/leaderboard` | All-time player rankings |

---

## Torn API Integration

All calls to the Torn API happen **only on the server**. The client never touches `api.torn.com` directly.

### House Account

The house account is a Torn player controlled by the platform operator. Its **full-access API key** is stored in the server's `.env` file only — never in code, never sent to the browser.

```
HOUSE_TORN_ID=3859772
HOUSE_API_KEY=your_full_access_key_here   # stored in .env ONLY
```

### How Deposits Are Verified

The server uses the house account's API key to check incoming transaction logs:

```javascript
// server/services/tornApi.js

async function verifyDeposit(playerTornId, expectedAmount, tornTxId) {
  const url = `https://api.torn.com/user/?selections=moneyoffered&key=${process.env.HOUSE_API_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();

  // Find the specific transaction by ID
  const tx = data.moneyoffered?.[tornTxId];

  if (!tx) return { ok: false, reason: 'Transaction not found.' };
  if (tx.sender_id !== playerTornId) return { ok: false, reason: 'Sender mismatch.' };
  if (tx.amount < expectedAmount)    return { ok: false, reason: 'Amount too low.' };
  if (tx.status !== 'received')      return { ok: false, reason: 'Not yet received.' };

  return { ok: true, amount: tx.amount, tornTxId };
}
```

### How Withdrawals Work

The operator manually sends Torn money to the player after a withdrawal request is logged. The server records the request as `pending` and the operator fulfills it in-game. (A future automated flow using the Torn trade API can be added.)

---

## Deposit & Withdrawal Flow

### Player Deposits

```
1. Player opens Torn City and sends $ to house account (Fucikos / ID 3859772)
   via Torn's in-game "Send Money" feature.

2. Player copies the Torn transaction ID from their event log.

3. Player opens Torn Nexus Wallet page, enters:
   - Amount they sent
   - Their Torn transaction ID

4. Client sends POST /api/wallet/deposit to the backend.

5. Server calls Torn API with HOUSE API KEY to verify:
   - Transaction exists
   - Sender matches logged-in player
   - Amount matches or exceeds claimed amount
   - Transaction hasn't already been credited (idempotency check)

6. If verified: server credits player's wallet in the database.

7. Client receives updated balance.
```

### Player Withdrawals

```
1. Player requests withdrawal via Torn Nexus Wallet page.

2. Server validates player has sufficient balance.

3. Server debits balance immediately and logs a 'pending_withdrawal' transaction.

4. Operator sees pending withdrawal in admin panel,
   manually sends Torn $ to the player in-game.

5. Operator marks withdrawal as fulfilled in admin panel,
   transaction status updates to 'completed'.
```

---

## Game Logic

The crash point is generated server-side before each round begins, using a seeded random function. The seed is published after the round ends so players can independently verify fairness.

```javascript
// server/utils/crashPoint.js

const crypto = require('crypto');

function generateCrashPoint(seed) {
  const hash = crypto.createHmac('sha256', seed).digest('hex');
  const r    = parseInt(hash.slice(0, 8), 16) / 0xFFFFFFFF; // 0..1

  // 3% instant-crash probability (house edge)
  if (r < 0.03) return 1.00;

  // Inverse-CDF geometric distribution
  const crash = 1 / (1 - r * 0.97);
  return Math.min(parseFloat(crash.toFixed(2)), 1000);
}
```

The game loop runs on the server. Clients poll `GET /api/game/state` every 100ms (or connect via WebSocket) to get the current multiplier. All bet placement and cashout actions are validated server-side before any balance changes.

---

## Environment Variables

Create a `.env` file in the `server/` directory. **Never commit this file.**

```env
# Server
PORT=3000
NODE_ENV=production

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/torn_nexus

# JWT
JWT_SECRET=your_very_long_random_secret_here
JWT_EXPIRES_IN=7d

# House Torn Account
HOUSE_TORN_ID=3859772
HOUSE_API_KEY=your_full_access_torn_api_key

# Encryption (for storing player API keys at rest)
ENCRYPTION_KEY=32_byte_hex_string_here
```

A `.env.example` file with blank values should be committed to the repo as a template.

---

## Setup & Installation

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- A Torn City account to act as the house account (with full-access API key)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/yourname/torn-nexus.git
cd torn-nexus

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env
# Edit .env with your values

# 4. Set up the database
npx prisma migrate dev --name init

# 5. Start the server
npm run dev       # development (nodemon)
npm start         # production
```

The client files in `client/` can be served as static files by the Express server, or deployed separately to a CDN.

---

## Security Considerations

| Risk | Mitigation |
|---|---|
| House API key exposure | Stored in `.env` only, never in code or sent to client |
| Player API key exposure | AES-256 encrypted at rest in DB; never returned to client after login |
| Double-crediting a deposit | Each `tornTxId` is stored; duplicate submissions are rejected |
| Negative balance exploit | All bet/withdrawal amounts validated against DB balance with a DB transaction (atomic) |
| Replay attacks | JWT expiry + transaction idempotency keys |
| SQL injection | Parameterized queries via Prisma ORM |
| Rate limiting | Per-IP rate limiting on all endpoints via `express-rate-limit` |

---

## Torn ToS Compliance

- This platform uses **only Torn City in-game dollars ($)** — no real-world currency is involved
- Players authenticate with their **own** limited-access API keys
- The house account API key is used solely to verify incoming transaction logs
- No automation of Torn gameplay occurs — only balance/transaction reads and manual sends
- The platform identifies itself as a fan-made tool unaffiliated with Torn City Ltd

> Always check the current [Torn City Terms of Service](https://www.torn.com/terms.php) before deploying. Rules around third-party tools and in-game currency exchange can change.
