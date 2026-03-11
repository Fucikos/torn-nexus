// api/game/state.js
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
      phase:            'WAITING',
      roundId:          0,
      multiplier:       '1.00',
      phaseEndsAt:      null,
      runningStartedAt: null,
      updatedAt:        new Date().toISOString(),
      myBet:            null,
    })
    return
  }

  // Look up the player's bet for the current round
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
        // busted = no cashout AND the round has ended
        busted: bet.cashoutMult === null && (state.phase === 'CRASHED' || state.phase === 'COOLDOWN'),
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
