// api/game/cashout.js
// Player voluntarily cashes out their active game at the current step's multiplier.
// Must have at least 1 step completed (can't cash out at 1x before crossing anything).

import { requireAuth }                              from '../../lib/auth.js'
import { prisma }                                   from '../../lib/prisma.js'
import { handleCors }                               from '../../lib/response.js'
import { calcPayout, generateOutcomes, survivalProbability } from '../../lib/gameLogic.js'

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
    res.status(404).json({ error: 'No active game to cash out.' }); return
  }

  if (game.stepsReached === 0) {
    res.status(400).json({ error: 'Cross at least one lane before cashing out!' }); return
  }

  // ── Calculate payout ─────────────────────────────────────────────────────────
  const { payout, fee, mult } = calcPayout(game.betAmount, game.stepsReached)

  // ── Atomic cashout guard (updateMany ensures only one concurrent request wins) ─
  const updated = await prisma.game.updateMany({
    where: { id: game.id, status: 'ACTIVE' },
    data: {
      cashoutMult: mult,
      payout,
      fee,
      status:  'CASHED_OUT',
      endedAt: new Date(),
    },
  })

  if (updated.count === 0) {
    res.status(409).json({ error: 'Game already ended.' }); return
  }

  // ── Credit wallet ─────────────────────────────────────────────────────────────
  await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: user.id },
      data:  { balance: { increment: payout } },
    }),
    prisma.transaction.create({
      data: {
        userId:      user.id,
        type:        'BET_WIN',
        amount:      payout,
        description: `Cashed out at ${mult}× after ${game.stepsReached} lane${game.stepsReached === 1 ? '' : 's'} — $${payout.toString()} (fee: $${fee.toString()})`,
        gameId:      game.id,
        status:      'COMPLETED',
      },
    }),
  ])

  const wallet  = await prisma.wallet.findUnique({ where: { userId: user.id } })
  const profit  = payout - game.betAmount

  // Reveal full provably-fair path
  const outcomes = generateOutcomes(game.seed)
  const revealedPath = outcomes.map((r, i) => ({
    lane:      i + 1,
    roll:      r.toFixed(4),
    threshold: survivalProbability(i + 1).toFixed(4),
    safe:      r < survivalProbability(i + 1),
  }))

  res.status(200).json({
    message:      `Cashed out at ${mult}×!`,
    cashoutMult:  mult,
    stepsReached: game.stepsReached,
    payout:       payout.toString(),
    profit:       profit.toString(),
    fee:          fee.toString(),
    balance:      wallet.balance.toString(),
    revealedPath,
  })
}
