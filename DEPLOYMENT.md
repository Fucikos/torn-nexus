# TORN NEXUS — Deployment Guide

Complete step-by-step guide to get Torn Nexus live on Vercel + Railway + Supabase.

---

## Prerequisites

Before starting, make sure you have:

- [ ] [Node.js 18+](https://nodejs.org) installed locally
- [ ] [Git](https://git-scm.com) installed
- [ ] A [GitHub](https://github.com) account
- [ ] A [Vercel](https://vercel.com) account (free)
- [ ] A [Railway](https://railway.app) account (free)
- [ ] A [Supabase](https://supabase.com) account (free)
- [ ] Your Torn City house account credentials ready (player ID + full-access API key)

---

## Step 1 — Supabase (Database)

### 1.1 Create a new project

1. Go to [supabase.com](https://supabase.com) → **New Project**
2. Choose your organisation
3. Fill in:
   - **Name:** `torn-nexus`
   - **Database Password:** generate a strong one and **save it somewhere safe**
   - **Region:** pick the closest to your players
4. Click **Create new project** — wait ~2 minutes for it to provision

### 1.2 Get your connection strings

1. In your project dashboard go to **Settings → Database**
2. Scroll to **Connection string** section
3. Copy two URLs:

**Connection pooling** (for `DATABASE_URL`) — use port **6543**:
```
postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true
```

**Direct connection** (for `DIRECT_URL`) — use port **5432**:
```
postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
```

Save both — you'll need them shortly.

### 1.3 Run database migrations

In your project folder locally:

```bash
# Install dependencies first
npm install

# Copy env template
cp .env.example .env
```

Edit `.env` and fill in at minimum:
```env
DATABASE_URL="your_pooling_url_here"
DIRECT_URL="your_direct_url_here"
```

Then run migrations:
```bash
npx prisma migrate dev --name init
```

You should see: `✓ Generated Prisma Client` and `✓ Applied 1 migration`

Verify in Supabase → **Table Editor** — you should see all 6 tables:
`users`, `wallets`, `transactions`, `rounds`, `bets`, `game_state`

---

## Step 2 — Generate All Secrets

Run these commands locally to generate secure values for your `.env`:

```bash
# JWT_SECRET (128 char hex)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# ENCRYPTION_KEY (64 char hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# GAME_SERVER_SECRET (64 char hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ADMIN_PASSWORD_HASH — replace 'yourpassword' with your chosen admin password
node -e "const b=require('bcryptjs');b.hash('yourpassword',10).then(console.log)"
```

Fill all values into your `.env`:

```env
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."

JWT_SECRET="generated_128_char_hex"
ENCRYPTION_KEY="generated_64_char_hex"
GAME_SERVER_SECRET="generated_64_char_hex"

HOUSE_TORN_ID="3859772"
HOUSE_API_KEY="your_full_access_torn_api_key"

ADMIN_PASSWORD_HASH="$2b$10$..."
```

---

## Step 3 — GitHub

### 3.1 Create the repository

1. Go to [github.com/new](https://github.com/new)
2. Name it `torn-nexus`
3. Set to **Private** (recommended)
4. Do NOT initialise with README (you already have one)
5. Click **Create repository**

### 3.2 Push your code

In your project folder:

```bash
git init
git add .
git commit -m "feat: initial torn nexus server edition"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/torn-nexus.git
git push -u origin main
```

Confirm all files appear in GitHub — especially check that `.env` is **not** there (`.gitignore` should prevent it).

---

## Step 4 — Vercel (Frontend + API Routes)

### 4.1 Import project

1. Go to [vercel.com/new](https://vercel.com/new)
2. Click **Import** next to your `torn-nexus` GitHub repo
3. Vercel will detect the `vercel.json` automatically
4. **Do not change** the build settings — leave as detected
5. Before clicking Deploy, click **Environment Variables**

### 4.2 Add environment variables

Add every variable from your `.env` file one by one:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Your Supabase pooling URL |
| `DIRECT_URL` | Your Supabase direct URL |
| `JWT_SECRET` | Generated hex string |
| `ENCRYPTION_KEY` | Generated hex string |
| `HOUSE_TORN_ID` | Your house account Torn ID |
| `HOUSE_API_KEY` | Your house account full-access API key |
| `ADMIN_PASSWORD_HASH` | bcrypt hash |
| `GAME_SERVER_SECRET` | Generated hex string |

Make sure to set each for **Production**, **Preview**, and **Development** environments.

### 4.3 Deploy

Click **Deploy** — Vercel will:
1. Install dependencies (`npm install`)
2. Run `prisma generate` (via `postinstall` script)
3. Build and deploy

After ~1 minute you'll get a live URL like `https://torn-nexus.vercel.app`

### 4.4 Verify API routes work

Test in your browser or with curl:

```bash
# Should return 401 Unauthorized (good — means route is live)
curl https://torn-nexus.vercel.app/api/auth/me

# Should return 405 Method Not Allowed (good)
curl https://torn-nexus.vercel.app/api/auth/login
```

---

## Step 5 — Railway (Game Server)

The game server is a persistent process that runs the crash loop forever. It cannot run on Vercel (serverless timeout). Railway keeps it alive 24/7.

### 5.1 Create a new Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Choose **Deploy from GitHub repo**
3. Select your `torn-nexus` repo
4. Railway will ask which directory — set **Root Directory** to `game-server`
5. It will detect `package.json` and use `npm start` automatically

### 5.2 Add environment variables

In Railway → your service → **Variables** tab, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Your Supabase **direct** URL (port 5432 — NOT pooling) |
| `DIRECT_URL` | Same as above |

> ⚠️ Railway needs the **direct** connection URL (port 5432), not the pooling one. The game server is a persistent process so it manages its own connections.

### 5.3 Deploy

Click **Deploy** — Railway will:
1. `npm install` inside `game-server/`
2. `prisma generate`
3. Start `node index.js`

### 5.4 Verify the game server is running

In Railway → your service → **Logs** tab, you should see:

```
[GameServer] Starting game loop…
[Round #1] Betting open — crash at X.XX× (hidden)
[Round #1] Running…
[Round #1] CRASHED at X.XX×
[Round #2] Betting open — crash at X.XX× (hidden)
```

If you see this, the game loop is working.

---

## Step 6 — Smoke Test Checklist

Go through each item to confirm everything is wired up correctly.

### Database
- [ ] Supabase → Table Editor shows 6 tables
- [ ] `game_state` table has 1 row (created by game server on first run)
- [ ] `rounds` table has rows appearing every ~15 seconds

### Game Server (Railway)
- [ ] Logs show the round loop cycling: Betting → Running → Crashed → Betting
- [ ] No error messages in logs
- [ ] `rounds` table in Supabase updates in real time

### Vercel API
- [ ] `GET /api/auth/me` returns 401 (route is live)
- [ ] `GET /api/game/state` returns 401 (route is live)
- [ ] Frontend loads at your Vercel URL

### Full Login Flow
- [ ] Open your Vercel URL
- [ ] Enter your Torn username + limited-access API key
- [ ] Login succeeds and shows home dashboard
- [ ] Balance shows $0 (correct — no deposits yet)
- [ ] Game page shows the multiplier counting up live

### Deposit Flow
- [ ] In Torn City, send $ to your house account
- [ ] Copy the transaction ID from your Torn event log
- [ ] In Torn Nexus → Wallet → enter amount + transaction ID
- [ ] Click Deposit — balance updates

### Game Flow
- [ ] Place a bet during betting phase
- [ ] Multiplier counts up live
- [ ] Click Cash Out — winnings appear
- [ ] Try busting — balance reduces correctly

### Admin Panel
- [ ] Go to `https://your-vercel-url.vercel.app/admin.html`
- [ ] Enter your admin password
- [ ] Pending withdrawals list appears (empty is fine)
- [ ] Request a withdrawal as a player, confirm it appears in admin panel
- [ ] Click "Mark Sent" — status updates

---

## Common Issues

### "Prisma client not generated"
```bash
npx prisma generate
```
This runs automatically via `postinstall` on Vercel but may need manual run locally.

### "Can't reach database" on Railway
Make sure Railway is using the **direct** Supabase URL (port 5432), not the pooling URL.

### "API key belongs to X, not Y"
The Torn username field is case-sensitive. Enter it exactly as it appears on your Torn profile.

### Game multiplier not updating
Check Railway logs — if the game server crashed, redeploy it. The `game_state` table should have `updated_at` changing every 100ms.

### Deposit not verifying
The Torn transaction ID must be the exact numeric ID from your event log. Check `HOUSE_TORN_ID` in your Vercel env vars matches your actual house account.

---

## Keeping It Updated

When you push new code to GitHub:
- **Vercel** redeploys automatically
- **Railway** redeploys automatically

To run a new database migration after schema changes:
```bash
npx prisma migrate dev --name describe_your_change
git add prisma/migrations
git commit -m "db: add migration"
git push
```

---

## URLs Summary

After full deployment you'll have:

| Service | URL |
|---|---|
| Frontend + API | `https://torn-nexus.vercel.app` |
| Admin Panel | `https://torn-nexus.vercel.app/admin.html` |
| Game Server Logs | Railway dashboard → Logs |
| Database | Supabase dashboard → Table Editor |
