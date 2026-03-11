import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const type = req.query?.type ?? 'history'
  const sort = req.query?.sort ?? 'profit'

  if (type === 'history') {
    const rounds = await prisma.round.findMany({
      where: { phase: 'CRASHED' }, orderBy: { endedAt: 'desc' }, take: 20,
      include: { bets: { where: { userId: user.id }, select: { amount: true, cashoutMult: true, payout: true } } },
    })
    // convert to string with at least four decimal places so the client
    // always sees the precision that was stored in the database
    res.status(200).json(rounds.map(r => ({
      id: r.id,
      crashPoint: parseFloat(r.crashPoint.toString()).toFixed(4),
      endedAt: r.endedAt?.toISOString(),
      myBet: r.bets[0]
        ? {
            amount: r.bets[0].amount.toString(),
            cashoutMult: r.bets[0].cashoutMult !== null
              ? parseFloat(r.bets[0].cashoutMult.toString()).toFixed(4)
              : null,
            payout: r.bets[0].payout.toString()
          }
        : null,
    })))
    return
  }

  if (type === 'leaderboard') {
    const users = await prisma.user.findMany({ include: { bets: { select: { amount: true, cashoutMult: true, payout: true } } } })
    const rows = users.map(u => {
      const wins = u.bets.filter(b => b.cashoutMult !== null).length
      const totalWagered = u.bets.reduce((s, b) => s + Number(b.amount), 0)
      const totalWon = u.bets.reduce((s, b) => s + Number(b.payout), 0)
      const bestMult = u.bets.reduce((m, b) => { const v = b.cashoutMult ? parseFloat(b.cashoutMult.toString()) : 0; return v > m ? v : m }, 0)
      return { username: u.username, isMe: u.id === user.id, rounds: u.bets.length, wins, wagered: totalWagered, profit: totalWon - totalWagered, bestMult }
    })
    rows.sort((a, b) => sort === 'wins' ? b.wins - a.wins : sort === 'wagered' ? b.wagered - a.wagered : b.profit - a.profit)
    res.status(200).json(rows)
    return
  }

  res.status(400).json({ error: 'Unknown type.' })
}