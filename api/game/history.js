// api/game/history.js
// GET /api/game/history  — last 20 completed rounds
// GET /api/game/leaderboard — all-time player rankings

import { requireAuth }         from '../../lib/auth.js'
import { prisma }              from '../../lib/prisma.js'
import { ok, err, handleCors } from '../../lib/response.js'

export default async function handler(req) {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'GET') return err('Method not allowed', 405)

  const user = await requireAuth(req)
  if (user instanceof Response) return user

  const url  = new URL(req.url, 'http://localhost')
  const type = url.searchParams.get('type') ?? 'history'

  // ── Round history ──────────────────────────────────────────────────────
  if (type === 'history') {
    const rounds = await prisma.round.findMany({
      where:   { phase: 'CRASHED' },
      orderBy: { endedAt: 'desc' },
      take:    20,
      include: {
        bets: {
          where: { userId: user.id },
          select: { amount: true, cashoutMult: true, payout: true },
        },
      },
    })

    return ok(rounds.map(r => ({
      id:         r.id,
      crashPoint: r.crashPoint.toString(),
      endedAt:    r.endedAt?.toISOString(),
      myBet:      r.bets[0] ? {
        amount:      r.bets[0].amount.toString(),
        cashoutMult: r.bets[0].cashoutMult?.toString() ?? null,
        payout:      r.bets[0].payout.toString(),
      } : null,
    })))
  }

  // ── Leaderboard ───────────────────────────────────────────────────────
  if (type === 'leaderboard') {
    const sort  = url.searchParams.get('sort') ?? 'profit'  // profit | wins | wagered
    const users = await prisma.user.findMany({
      include: {
        bets: {
          select: { amount: true, cashoutMult: true, payout: true },
        },
      },
    })

    const rows = users.map(u => {
      const totalRounds  = u.bets.length
      const wins         = u.bets.filter(b => b.cashoutMult !== null).length
      const totalWagered = u.bets.reduce((s, b) => s + Number(b.amount), 0)
      const totalWon     = u.bets.reduce((s, b) => s + Number(b.payout), 0)
      const profit       = totalWon - totalWagered
      const bestMult     = u.bets.reduce((m, b) => {
        const v = b.cashoutMult ? parseFloat(b.cashoutMult.toString()) : 0
        return v > m ? v : m
      }, 0)

      return {
        username: u.username,
        isMe:     u.id === user.id,
        rounds:   totalRounds,
        wins,
        wagered:  totalWagered,
        profit,
        bestMult,
      }
    })

    const sorted = rows.sort((a, b) => {
      if (sort === 'wins')    return b.wins    - a.wins
      if (sort === 'wagered') return b.wagered - a.wagered
      return b.profit - a.profit  // default: profit
    })

    return ok(sorted)
  }

  return err('Unknown type. Use ?type=history or ?type=leaderboard')
}
