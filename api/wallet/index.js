// game-server/index.js
// Persistent Node.js process — runs on Railway (NOT Vercel).
// Manages the crash game loop: cooldown → betting → running → crashed → repeat.
// Writes game state to Supabase every tick so Vercel API routes can read it.

import { PrismaClient } from '@prisma/client'
import { createHmac, randomBytes } from 'crypto'

const prisma = new PrismaClient()

const BETTING_DURATION_MS  = 8_000
const COOLDOWN_DURATION_MS = 4_000
const CRASHED_DISPLAY_MS   = 3_000   // how long CRASHED phase shows before cooldown
const TICK_INTERVAL_MS     = 100
const HOUSE_EDGE           = 0.03

function generateCrashPoint(seed) {
  const hash = createHmac('sha256', seed).digest('hex')
  const r    = parseInt(hash.slice(0, 8), 16) / 0xFFFFFFFF
  if (r < HOUSE_EDGE) return 1.00
  const crash = 1 / (1 - r * (1 - HOUSE_EDGE))
  return Math.min(parseFloat(crash.toFixed(2)), 1000)
}

// IMPORTANT: client/main.js uses the same formula for interpolation.
// If you change this, update calcMultiplierAt() in main.js too.
function calcMultiplier(elapsedSec) {
  return parseFloat((1 + Math.pow(elapsedSec, 1.5) * 0.25).toFixed(4))
}

async function gameLoop() {
  console.log('[GameServer] Starting…')

  await prisma.gameState.upsert({
    where:  { id: 1 },
    update: {},
    create: {
      id: 1, roundId: 0, phase: 'COOLDOWN',
      multiplier: 1.00,
      phaseEndsAt: new Date(Date.now() + COOLDOWN_DURATION_MS),
      runningStartedAt: null,
    },
  })

  while (true) {
    await runCooldownPhase()
    await runBettingPhase()
    await runRunningPhase()   // internally calls handleCrash + waits CRASHED_DISPLAY_MS
  }
}

// ── COOLDOWN: distinct phase so clients disable betting ────────────────────
async function runCooldownPhase() {
  const endsAt = new Date(Date.now() + COOLDOWN_DURATION_MS)
  await prisma.gameState.update({
    where: { id: 1 },
    data:  { phase: 'COOLDOWN', multiplier: 1.00, phaseEndsAt: endsAt, runningStartedAt: null },
  })
  console.log('[GameServer] Cooldown…')
  await sleep(COOLDOWN_DURATION_MS)
}

// ── BETTING: create round first, THEN open betting ─────────────────────────
async function runBettingPhase() {
  const seed       = randomBytes(32).toString('hex')
  const crashPoint = generateCrashPoint(seed)
  const endsAt     = new Date(Date.now() + BETTING_DURATION_MS)

  // Round must exist before phase=BETTING so bet.js can reference it
  const round = await prisma.round.create({
    data: { crashPoint, seed, phase: 'BETTING' },
  })

  await prisma.gameState.update({
    where: { id: 1 },
    data:  {
      roundId: round.id, phase: 'BETTING',
      multiplier: 1.00, phaseEndsAt: endsAt, runningStartedAt: null,
    },
  })

  console.log(`[Round #${round.id}] Betting open (crash at ${crashPoint}× — hidden)`)
  await sleep(BETTING_DURATION_MS)
}

// ── RUNNING: tick multiplier until crash ───────────────────────────────────
async function runRunningPhase() {
  const state = await prisma.gameState.findUnique({ where: { id: 1 } })
  const round = await prisma.round.findUnique({ where: { id: state.roundId } })
  const crashPoint = parseFloat(round.crashPoint.toString())
  const startTime  = new Date()

  await prisma.round.update({ where: { id: round.id }, data: { phase: 'RUNNING' } })

  // Write runningStartedAt so clients can anchor their interpolation clock
  await prisma.gameState.update({
    where: { id: 1 },
    data:  {
      phase: 'RUNNING',
      phaseEndsAt: new Date(Date.now() + 120_000),
      runningStartedAt: startTime,
      multiplier: 1.00,
    },
  })

  console.log(`[Round #${round.id}] Running…`)

  while (true) {
    await sleep(TICK_INTERVAL_MS)
    const elapsed = (Date.now() - startTime.getTime()) / 1000
    const mult    = calcMultiplier(elapsed)

    await prisma.gameState.update({ where: { id: 1 }, data: { multiplier: mult } })

    if (mult >= crashPoint) {
      console.log(`[Round #${round.id}] CRASHED at ${mult.toFixed(4)}×`)
      await handleCrash(round.id, mult)
      // Hold CRASHED state so clients can show crash screen
      await sleep(CRASHED_DISPLAY_MS)
      return
    }
  }
}

// ── CRASHED: write state, wait for in-flight requests, resolve busts ───────
async function handleCrash(roundId, finalMult) {
  // Write CRASHED immediately — cashout.js checks phase before writing
  await prisma.round.update({
    where: { id: roundId },
    data:  { phase: 'CRASHED', endedAt: new Date() },
  })
  await prisma.gameState.update({
    where: { id: 1 },
    data:  { phase: 'CRASHED', multiplier: finalMult, runningStartedAt: null },
  })

  // Wait 300ms so any in-flight cashout HTTP requests that hit Vercel just before
  // crash have time to read phase=CRASHED and get rejected cleanly
  await sleep(300)

  // Resolve all bets that didn't cash out
  const bustedBets = await prisma.bet.findMany({
    where: { roundId, cashoutMult: null },
  })

  for (const bet of bustedBets) {
    await prisma.$transaction([
      prisma.bet.update({
        where: { id: bet.id },
        data:  { payout: BigInt(0) },
      }),
      prisma.transaction.create({
        data: {
          userId:      bet.userId,
          type:        'BET_LOSS',
          amount:      bet.amount,
          description: `Busted — Round #${roundId} crashed at ${finalMult.toFixed(2)}×`,
          roundId,
          status:      'COMPLETED',
        },
      }),
    ])
  }

  console.log(`[Round #${roundId}] ${bustedBets.length} bust(s) resolved.`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

gameLoop().catch(err => {
  console.error('[GameServer] Fatal:', err)
  process.exit(1)
})
