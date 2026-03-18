// api/game/step.js
// Player clicks to cross the next lane.
// Server checks the pre-generated outcome for that lane.
// If safe → increment stepsReached, return safe + new multiplier.
// If hit  → mark game BUSTED, record BET_LOSS transaction.
// If step 8 cleared → auto cash out at 5x.

import { requireAuth }                                      from '../../lib/auth.js'
import { prisma }                                           from '../../lib/prisma.js'
import { handleCors }                                       from '../../lib/response.js'
import { generateOutcomes, survivalProbability, calcPayout, MULTIPLIERS, MAX_STEPS } from '../../lib/gameLogic.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  // ── Find active game ─────────────────────────────────────────────────────────
  const game = await prisma.game.findFirst({
    where: { userId: user.id, status: 'ACTIVE' },
  })
  if (!game) {
    res.status(404).json({ error: 'No active game. Start a new game first.' }); return
  }

  const nextStep = game.stepsReached + 1 // 1-based lane number

  // Shouldn't happen if client is well-behaved, but guard anyway
  if (nextStep > MAX_STEPS) {
    res.status(409).json({ error: 'Game already complete.' }); return
  }

  // ── Determine outcome from server seed ──────────────────────────────────────
  const outcomes  = generateOutcomes(game.seed)  // array of 8 floats
  const roll      = outcomes[nextStep - 1]        // 0-indexed
  const threshold = survivalProbability(nextStep)
  const safe      = roll < threshold

  if (!safe) {
    // ── BUSTED ───────────────────────────────────────────────────────────────
    await prisma.$transaction([
      prisma.game.update({
        where: { id: game.id },
        data: {
          stepsReached: nextStep,   // record how far they got before dying
          status:       'BUSTED',
          payout:       BigInt(0),
          endedAt:      new Date(),
        },
      }),
      prisma.transaction.create({
        data: {
          userId:      user.id,
          type:        'BET_LOSS',
          amount:      game.betAmount,
          description: `Chicken got hit on lane ${nextStep} — lost $${game.betAmount.toString()}`,
          gameId:      game.id,
          status:      'COMPLETED',
        },
      }),
    ])

    // Reveal ALL outcomes now the game is over (provably fair)
    const allOutcomes = outcomes.map((r, i) => ({
      lane:   i + 1,
      roll:   r.toFixed(4),
      threshold: survivalProbability(i + 1).toFixed(4),
      safe:   r < survivalProbability(i + 1),
    }))

    return res.status(200).json({
      result:       'BUSTED',
      laneHit:      nextStep,
      stepsReached: nextStep,
      payout:       '0',
      balance:      null,   // caller can refresh wallet
      revealedPath: allOutcomes,
    })
  }

  // ── SAFE ─────────────────────────────────────────────────────────────────────
  const newSteps = nextStep

  // Check if this was the last lane — auto cash out at max
  if (newSteps === MAX_STEPS) {
    const { payout, fee, mult } = calcPayout(game.betAmount, newSteps)

    await prisma.$transaction([
      prisma.game.update({
        where: { id: game.id },
        data: {
          stepsReached: newSteps,
          cashoutMult:  mult,
          payout,
          fee,
          status:   'CASHED_OUT',
          endedAt:  new Date(),
        },
      }),
      prisma.wallet.update({
        where: { userId: user.id },
        data:  { balance: { increment: payout } },
      }),
      prisma.transaction.create({
        data: {
          userId:      user.id,
          type:        'BET_WIN',
          amount:      payout,
          description: `Chicken crossed all ${MAX_STEPS} lanes! Auto cash-out at ${mult}× — $${payout.toString()}`,
          gameId:      game.id,
          status:      'COMPLETED',
        },
      }),
    ])

    const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
    const allOutcomes = outcomes.map((r, i) => ({
      lane:      i + 1,
      roll:      r.toFixed(4),
      threshold: survivalProbability(i + 1).toFixed(4),
      safe:      r < survivalProbability(i + 1),
    }))

    return res.status(200).json({
      result:       'SAFE',
      autoComplete: true,
      stepsReached: newSteps,
      currentMult:  mult,
      payout:       payout.toString(),
      fee:          fee.toString(),
      balance:      wallet.balance.toString(),
      revealedPath: allOutcomes,
    })
  }

  // Normal safe step — just advance
  await prisma.game.update({
    where: { id: game.id },
    data:  { stepsReached: newSteps },
  })

  const { mult } = calcPayout(game.betAmount, newSteps)

  return res.status(200).json({
    result:         'SAFE',
    autoComplete:   false,
    stepsReached:   newSteps,
    currentMult:    MULTIPLIERS[newSteps],
    nextMult:       MULTIPLIERS[newSteps + 1] ?? null,
    canCashOut:     true,
  })
}
