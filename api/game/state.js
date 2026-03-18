// api/game/state.js
// Returns the player's active game state (if any) plus recent game history.

import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'
import { MULTIPLIERS } from '../../lib/gameLogic.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  // Active game
  const activeGame = await prisma.game.findFirst({
    where: { userId: user.id, status: 'ACTIVE' },
  })

  // Last 20 completed games for history
  const history = await prisma.game.findMany({
    where:   { userId: user.id, status: { not: 'ACTIVE' } },
    orderBy: { createdAt: 'desc' },
    take:    20,
    select: {
      id:           true,
      betAmount:    true,
      stepsReached: true,
      cashoutMult:  true,
      payout:       true,
      status:       true,
      createdAt:    true,
    },
  })

  res.status(200).json({
    activeGame: activeGame ? {
      gameId:       activeGame.id,
      betAmount:    activeGame.betAmount.toString(),
      stepsReached: activeGame.stepsReached,
      currentMult:  MULTIPLIERS[activeGame.stepsReached],
      nextMult:     MULTIPLIERS[activeGame.stepsReached + 1] ?? null,
      status:       activeGame.status,
    } : null,
    history: history.map(g => ({
      gameId:       g.id,
      betAmount:    g.betAmount.toString(),
      stepsReached: g.stepsReached,
      cashoutMult:  g.cashoutMult ? parseFloat(g.cashoutMult.toString()) : null,
      payout:       g.payout.toString(),
      status:       g.status,
      createdAt:    g.createdAt.toISOString(),
    })),
    multipliers: MULTIPLIERS,
  })
}
