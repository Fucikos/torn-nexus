// api/game/state.js
// GET /api/game/state
// Clients poll this every 100ms to get the current multiplier and round info.
// Kept extremely lightweight — reads one row from game_state table.

import { requireAuth }         from '../../lib/auth.js'
import { prisma }              from '../../lib/prisma.js'
import { ok, err, handleCors } from '../../lib/response.js'

export default async function handler(req) {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'GET') return err('Method not allowed', 405)

  const user = await requireAuth(req)
  if (user instanceof Response) return user

  // Read game state row (always id=1)
  const state = await prisma.gameState.findUnique({ where: { id: 1 } })

  if (!state) {
    return ok({
      phase:       'WAITING',
      roundId:     0,
      multiplier:  '1.00',
      phaseEndsAt: null,
    })
  }

  // Also fetch the player's active bet for this round (if any)
  const myBet = await prisma.bet.findUnique({
    where: {
      userId_roundId: {
        userId:  user.id,
        roundId: state.roundId,
      },
    },
  })

  return ok({
    phase:       state.phase,
    roundId:     state.roundId,
    multiplier:  state.multiplier.toString(),
    phaseEndsAt: state.phaseEndsAt.toISOString(),
    updatedAt:   state.updatedAt.toISOString(),
    myBet: myBet ? {
      amount:      myBet.amount.toString(),
      cashoutMult: myBet.cashoutMult?.toString() ?? null,
      payout:      myBet.payout.toString(),
      busted:      myBet.cashoutMult === null && state.phase === 'CRASHED',
    } : null,
  })
}
