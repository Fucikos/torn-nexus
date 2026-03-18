// api/game/history.js
import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const type = req.query?.type ?? 'history'

  if (type === 'leaderboard') {
    // Aggregate stats per user
    const raw = await prisma.game.groupBy({
      by:    ['userId'],
      where: { status: { not: 'ACTIVE' } },
      _count: { id: true },
      _sum:   { betAmount: true, payout: true },
      _max:   { cashoutMult: true },
    })

    // Get usernames
    const userIds  = raw.map(r => r.userId)
    const users    = await prisma.user.findMany({
      where:  { id: { in: userIds } },
      select: { id: true, username: true },
    })
    const nameMap  = Object.fromEntries(users.map(u => [u.id, u.username]))

    // Count wins (CASHED_OUT)
    const wins = await prisma.game.groupBy({
      by:    ['userId'],
      where: { status: 'CASHED_OUT' },
      _count: { id: true },
    })
    const winMap = Object.fromEntries(wins.map(w => [w.userId, w._count.id]))

    const leaderboard = raw.map(r => {
      const wagered = Number(r._sum.betAmount ?? 0n)
      const payout  = Number(r._sum.payout   ?? 0n)
      return {
        username: nameMap[r.userId] ?? 'Unknown',
        isMe:     r.userId === user.id,
        rounds:   r._count.id,
        wins:     winMap[r.userId] ?? 0,
        wagered,
        profit:   payout - wagered,
        bestMult: r._max.cashoutMult ? parseFloat(r._max.cashoutMult.toString()) : 0,
      }
    })

    return res.status(200).json(leaderboard)
  }

  // Default: personal history
  const games = await prisma.game.findMany({
    where:   { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take:    50,
  })

  res.status(200).json(games.map(g => ({
    gameId:       g.id,
    betAmount:    g.betAmount.toString(),
    stepsReached: g.stepsReached,
    cashoutMult:  g.cashoutMult ? parseFloat(g.cashoutMult.toString()) : null,
    payout:       g.payout.toString(),
    status:       g.status,
    createdAt:    g.createdAt.toISOString(),
  })))
}
