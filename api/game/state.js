import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const state = await prisma.gameState.findUnique({ where: { id: 1 } })

  if (!state) {
    res.status(200).json({ phase: 'WAITING', roundId: 0, multiplier: '1.00', phaseEndsAt: null })
    return
  }

  const myBet = await prisma.bet.findUnique({
    where: { userId_roundId: { userId: user.id, roundId: state.roundId } },
  })

  res.status(200).json({
    phase:            state.phase,
    roundId:          state.roundId,
    multiplier:       state.multiplier.toString(),
    phaseEndsAt:      state.phaseEndsAt.toISOString(),
    updatedAt:        state.updatedAt.toISOString(),
    runningStartedAt: state.runningStartedAt?.toISOString() ?? null,
    myBet: myBet ? {
      amount:      myBet.amount.toString(),
      cashoutMult: myBet.cashoutMult?.toString() ?? null,
      payout:      myBet.payout.toString(),
      busted:      myBet.cashoutMult === null && state.phase === 'CRASHED',
    } : null,
  })
}