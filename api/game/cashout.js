import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const state = await prisma.gameState.findUnique({ where: { id: 1 } })
  if (!state || state.phase !== 'RUNNING') { res.status(409).json({ error: 'Round is not in progress.' }); return }

  const currentMult = parseFloat(state.multiplier.toString())
  const bet = await prisma.bet.findUnique({
    where: { userId_roundId: { userId: user.id, roundId: state.roundId } },
  })

  if (!bet)            { res.status(404).json({ error: 'No active bet found.' }); return }
  if (bet.cashoutMult) { res.status(409).json({ error: 'Already cashed out.' }); return }

  const payout = BigInt(Math.floor(Number(bet.amount) * currentMult))
  const profit = payout - bet.amount

  await prisma.$transaction([
    prisma.bet.update({ where: { id: bet.id }, data: { cashoutMult: currentMult, payout } }),
    prisma.wallet.update({ where: { userId: user.id }, data: { balance: { increment: payout } } }),
    prisma.transaction.create({
      data: { userId: user.id, type: 'BET_WIN', amount: payout, description: `Cashed out at ${currentMult.toFixed(2)}× — Round #${state.roundId}`, roundId: state.roundId, status: 'COMPLETED' },
    }),
  ])

  const updatedWallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  res.status(200).json({ message: `Cashed out at ${currentMult.toFixed(2)}×!`, cashoutMult: currentMult.toFixed(2), payout: payout.toString(), profit: profit.toString(), balance: updatedWallet.balance.toString() })
}