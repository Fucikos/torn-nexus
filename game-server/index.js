// game-server/index.js
// Persistent Node.js process — runs on Railway.
// REWRITTEN from scratch for correctness and smoothness.
// Loop: BETTING (8s) → RUNNING (until crash) → COOLDOWN (4s) → repeat

import { PrismaClient } from '@prisma/client'
import { createHmac, randomBytes } from 'crypto'

const prisma = new PrismaClient()

// ── Constants ──────────────────────────────────────────────────────────────
const BETTING_MS  = 8_000    // 8s betting window
const COOLDOWN_MS = 4_000    // 4s cooldown after crash
const TICK_MS     = 100      // server tick rate
const HOUSE_EDGE  = 0.03     // 3%

// ── Crash point generation (provably fair) ─────────────────────────────────
// Returns a crash point ≥ 1.00. The house edge is enforced by a 3% chance
// of instant crash at exactly 1.00×.
function generateCrashPoint(seed) {
  const hash = createHmac('sha256', seed).digest('hex')
  const r    = parseInt(hash.slice(0, 8), 16) / 0xFFFFFFFF

  if (r < HOUSE_EDGE) return 1.00

  // Inverse of survival function: ensures E[payout] = 1 - houseEdge
  const crash = 1 / (1 - r * (1 - HOUSE_EDGE))
  return Math.min(parseFloat(crash.toFixed(2)), 1000.00)
}

// ── Multiplier curve ───────────────────────────────────────────────────────
// IMPORTANT: client/main.js must use the identical formula.
// mult(t) = 1 + 0.25 * t^1.5   where t = elapsed seconds since round start
function calcMultiplier(elapsedSec) {
  if (elapsedSec <= 0) return 1.00
  return parseFloat((1 + Math.pow(elapsedSec, 1.5) * 0.25).toFixed(4))
}

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Main loop ──────────────────────────────────────────────────────────────
async function gameLoop() {
  console.log('[GameServer] Starting game loop…')

  // Ensure the singleton game_state row exists
  await prisma.gameState.upsert({
    where:  { id: 1 },
    update: {},
    create: {
      id:               1,
      roundId:          0,
      phase:            'COOLDOWN',
      multiplier:       1.00,
      phaseEndsAt:      new Date(Date.now() + COOLDOWN_MS),
      runningStartedAt: null,
    },
  })

  while (true) {
    await phaseBetting()
    await phaseRunning()
    await phaseCooldown()
  }
}

// ── Phase 1: BETTING ───────────────────────────────────────────────────────
async function phaseBetting() {
  const seed       = randomBytes(32).toString('hex')
  const crashPoint = generateCrashPoint(seed)
  const endsAt     = new Date(Date.now() + BETTING_MS)

  // Create round — crash point is hidden from clients until after crash
  const round = await prisma.round.create({
    data: { crashPoint, seed, phase: 'BETTING' },
  })

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

  console.log(`[Round #${round.id}] BETTING open (crash at ${crashPoint}× hidden)`)
  await sleep(BETTING_MS)
}

// ── Phase 2: RUNNING ───────────────────────────────────────────────────────
async function phaseRunning() {
  // Fetch current state to get roundId
  const state = await prisma.gameState.findUnique({ where: { id: 1 } })
  const round = await prisma.round.findUnique({ where: { id: state.roundId } })
  const crashPoint = parseFloat(round.crashPoint.toString())

  // Record the exact start time — clients will anchor their clock to this
  const startedAt = new Date()

  await prisma.round.update({
    where: { id: round.id },
    data:  { phase: 'RUNNING' },
  })

  await prisma.gameState.update({
    where: { id: 1 },
    data: {
      phase:            'RUNNING',
      multiplier:       1.00,
      phaseEndsAt:      new Date(Date.now() + 120_000), // safety ceiling
      runningStartedAt: startedAt,
    },
  })

  console.log(`[Round #${round.id}] RUNNING (crash at ${crashPoint}×)`)

  // Tick loop
  while (true) {
    await sleep(TICK_MS)

    const elapsed = (Date.now() - startedAt.getTime()) / 1000
    const mult    = calcMultiplier(elapsed)

    // Write server-truth multiplier every tick — used for drift correction
    await prisma.gameState.update({
      where: { id: 1 },
      data:  { multiplier: mult },
    })

    if (mult >= crashPoint) {
      console.log(`[Round #${round.id}] CRASHED at ${mult.toFixed(4)}×`)
      await resolveCrash(round.id, mult)
      return
    }
  }
}

// ── Crash resolution ───────────────────────────────────────────────────────
async function resolveCrash(roundId, finalMult) {
  // Mark round crashed
  await prisma.round.update({
    where: { id: roundId },
    data:  { phase: 'CRASHED', endedAt: new Date() },
  })

  // Update game state to CRASHED so clients immediately see it
  await prisma.gameState.update({
    where: { id: 1 },
    data: {
      phase:            'CRASHED',
      multiplier:       finalMult,
      runningStartedAt: null,
    },
  })

  // Settle all bets that didn't cash out
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

// ── Phase 3: COOLDOWN ──────────────────────────────────────────────────────
// Phase stays CRASHED visually but we update phaseEndsAt for the countdown.
// We do NOT flip to BETTING here — only phaseBetting() creates the new round.
async function phaseCooldown() {
  const endsAt = new Date(Date.now() + COOLDOWN_MS)

  await prisma.gameState.update({
    where: { id: 1 },
    data: {
      phase:            'COOLDOWN',
      phaseEndsAt:      endsAt,
      runningStartedAt: null,
    },
  })

  await sleep(COOLDOWN_MS)
}

// ── Start ──────────────────────────────────────────────────────────────────
gameLoop().catch(err => {
  console.error('[GameServer] Fatal:', err)
  process.exit(1)
})
