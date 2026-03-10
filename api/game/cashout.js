// api/game/cashout.js
// POST /api/game/cashout
// Cashes out at the current multiplier. Only allowed during RUNNING phase.

import { requireAuth }         from '../../lib/auth.js'
import { prisma }              from '../../lib/prisma.js'
import { ok, err, handleCors } from '../../lib/response.js'

export default async function handler(req) {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'POST') return err('Method not allowed', 405)

  const user = await requireAuth(req)
  if (user instanceof Response) return user

  // ── Validate game phase ────────────────────────────────────────────────
  const state = await prisma.gameState.findUnique({ where: { id: 1 } })
  if (!state || state.phase !== 'RUNNING') {
    return err('Round is not in progress.', 409)
  }

  const currentMult = parseFloat(state.multiplier.toString())

  // ── Find active bet ────────────────────────────────────────────────────
  const bet = await prisma.bet.findUnique({
    where: {
      userId_roundId: { userId: user.id, roundId: state.roundId },
    },
  })

  if (!bet)               return err('No active bet found.', 404)
  if (bet.cashoutMult)    return err('Already cashed out.', 409)

  const payout     = BigInt(Math.floor(Number(bet.amount) * currentMult))
  const profit     = payout - bet.amount

  // ── Credit winnings + update bet atomically ───────────────────────────
  await prisma.$transaction([
    prisma.bet.update({
      where: { id: bet.id },
      data:  {
        cashoutMult: currentMult,
        payout,
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
        description: `Cashed out at ${currentMult.toFixed(2)}× — Round #${state.roundId}`,
        roundId:     state.roundId,
        status:      'COMPLETED',
      },
    }),
  ])

  const updatedWallet = await prisma.wallet.findUnique({ where: { userId: user.id } })

  return ok({
    message:     `Cashed out at ${currentMult.toFixed(2)}× — won $${profit.toLocaleString()}!`,
    cashoutMult: currentMult.toFixed(2),
    payout:      payout.toString(),
    profit:      profit.toString(),
    balance:     updatedWallet.balance.toString(),
  })
}
