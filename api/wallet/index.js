// game-server/index.js
// Persistent Node.js process — runs on Railway (NOT Vercel).
// Manages the crash game loop: betting → running → crashed → cooldown → repeat.
// Writes game state to the shared Supabase DB every tick so Vercel API routes can serve it.

import { PrismaClient } from '@prisma/client'
import { createHmac, randomBytes } from 'crypto'

const prisma = new PrismaClient()

// ── Constants ──────────────────────────────────────────────────────────────
const BETTING_DURATION_MS  = 8_000   //  8 second betting window
const COOLDOWN_DURATION_MS = 4_000   //  4 second cooldown between rounds
// NOTE: During cooldown the DB phase is set to 'COOLDOWN', not 'BETTING'.
// 'BETTING' is only set once the new round row exists in runBettingPhase().
const TICK_INTERVAL_MS     = 100     //  update multiplier every 100ms
const HOUSE_EDGE           = 0.03    //  3%

// ── Crash point generation (provably fair) ─────────────────────────────────
function generateCrashPoint(seed) {
  const hash = createHmac('sha256', seed).digest('hex')
  const r    = parseInt(hash.slice(0, 8), 16) / 0xFFFFFFFF

  // 3% instant-crash enforces house edge
  if (r < HOUSE_EDGE) return 1.00

  const crash = 1 / (1 - r * (1 - HOUSE_EDGE))
  return Math.min(parseFloat(crash.toFixed(2)), 1000)
}

// ── Multiplier from elapsed time (seconds) ─────────────────────────────────
// NOTE: client/main.js uses the same formula for smooth interpolation.
// If you change this, update calcMultiplierAt() in main.js too.
function calcMultiplier(elapsedSec) {
  return parseFloat((1 + Math.pow(elapsedSec, 1.5) * 0.25).toFixed(4))
}

// ── Main game loop ─────────────────────────────────────────────────────────
async function gameLoop() {
  console.log('[GameServer] Starting game loop…')

  // Ensure game_state row exists
  await prisma.gameState.upsert({
    where:  { id: 1 },
    update: {},
    create: {
      id:               1,
      roundId:          0,
      phase:            'COOLDOWN',
      multiplier:       1.00,
      phaseEndsAt:      new Date(Date.now() + BETTING_DURATION_MS),
      runningStartedAt: null,
    },
  })

  while (true) {
    await runBettingPhase()
    await runRunningPhase()
    await runCooldownPhase()
  }
}

// ── Phase 1: Betting (8s) ──────────────────────────────────────────────────
async function runBettingPhase() {
  const seed       = randomBytes(32).toString('hex')
  const crashPoint = generateCrashPoint(seed)
  const endsAt     = new Date(Date.now() + BETTING_DURATION_MS)

  // Create the round row
  const round = await prisma.round.create({
    data: { crashPoint, seed, phase: 'BETTING' },
  })

  // Update game state — clear runningStartedAt from previous round
  await prisma.gameState.update({
    where: { id: 1 },
    data: {
      roundId:          round.id,
      phase:            'BETTING',
      multiplier:       1.00,
      phaseEndsAt:      endsAt,
      runningStartedAt: null,
    },
  })

  console.log(`[Round #${round.id}] Betting open — crash at ${crashPoint}× (hidden)`)
  await sleep(BETTING_DURATION_MS)
}

// ── Phase 2: Running (until crash) ────────────────────────────────────────
async function runRunningPhase() {
  const state = await prisma.gameState.findUnique({ where: { id: 1 } })
  const round = await prisma.round.findUnique({ where: { id: state.roundId } })

  const crashPoint = parseFloat(round.crashPoint.toString())

  const startTime = new Date()

  await prisma.round.update({
    where: { id: round.id },
    data:  { phase: 'RUNNING' },
  })

  // Store runningStartedAt so the client can anchor its interpolation clock
  await prisma.gameState.update({
    where: { id: 1 },
    data:  {
      phase:            'RUNNING',
      phaseEndsAt:      new Date(Date.now() + 120_000),
      runningStartedAt: startTime,
      multiplier:       1.00,
    },
  })

  console.log(`[Round #${round.id}] Running…`)

  while (true) {
    await sleep(TICK_INTERVAL_MS)

    const elapsed = (Date.now() - startTime.getTime()) / 1000
    const mult    = calcMultiplier(elapsed)

    // Update multiplier in DB every tick (used as server truth / sync check)
    await prisma.gameState.update({
      where: { id: 1 },
      data:  { multiplier: mult },
    })

    // Crash check
    if (mult >= crashPoint) {
      console.log(`[Round #${round.id}] CRASHED at ${mult.toFixed(4)}×`)
      await handleCrash(round.id, mult)
      return
    }
  }
}

// ── Crash resolution ───────────────────────────────────────────────────────
async function handleCrash(roundId, finalMult) {
  await prisma.round.update({
    where: { id: roundId },
    data:  { phase: 'CRASHED', endedAt: new Date() },
  })

  await prisma.gameState.update({
    where: { id: 1 },
    data:  {
      phase:            'CRASHED',
      multiplier:       finalMult,
      runningStartedAt: null,
    },
  })

  // Find all bets that didn't cash out and mark as losses
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

  console.log(`[Round #${roundId}] ${bustedBets.length} busted bet(s) resolved.`)
}

// ── Phase 3: Cooldown (4s) ─────────────────────────────────────────────────
// Set phase to COOLDOWN (not BETTING) so clients don't try to place bets
// before the new round row exists. BETTING is set inside runBettingPhase()
// only after the round has been created.
async function runCooldownPhase() {
  const endsAt = new Date(Date.now() + COOLDOWN_DURATION_MS)
  await prisma.gameState.update({
    where: { id: 1 },
    data:  {
      phase:            'COOLDOWN',
      phaseEndsAt:      endsAt,
      runningStartedAt: null,
    },
  })
  await sleep(COOLDOWN_DURATION_MS)
}

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Start ──────────────────────────────────────────────────────────────────
gameLoop().catch(err => {
  console.error('[GameServer] Fatal error:', err)
  process.exit(1)
})
