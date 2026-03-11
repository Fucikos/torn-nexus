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
    res.status(200).json({
      phase: 'COOLDOWN', roundId: 0, multiplier: '1.00',
      phaseEndsAt: null, runningStartedAt: null, myBet: null,
    })
    return
  }

  // Only look up myBet when there's an active round
  let myBet = null
  if (state.roundId > 0) {
    const bet = await prisma.bet.findUnique({
      where: { userId_roundId: { userId: user.id, roundId: state.roundId } },
    })
    if (bet) {
      myBet = {
        amount:      bet.amount.toString(),
        cashoutMult: bet.cashoutMult?.toString() ?? null,
        payout:      bet.payout.toString(),
        // busted = no cashout AND round is over
        busted: bet.cashoutMult === null && state.phase === 'CRASHED',
      }
    }
  }

  res.status(200).json({
    phase:            state.phase,
    roundId:          state.roundId,
    multiplier:       state.multiplier.toString(),
    phaseEndsAt:      state.phaseEndsAt?.toISOString() ?? null,
    runningStartedAt: state.runningStartedAt?.toISOString() ?? null,
    updatedAt:        state.updatedAt.toISOString(),
    myBet,
  })
}
