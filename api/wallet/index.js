import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const [wallet, transactions] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId: user.id } }),
    prisma.transaction.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ])

  if (!wallet) { res.status(404).json({ error: 'Wallet not found' }); return }

  res.status(200).json({
    balance:        wallet.balance.toString(),
    totalDeposited: wallet.totalDeposited.toString(),
    totalWithdrawn: wallet.totalWithdrawn.toString(),
    transactions: transactions.map(tx => ({
      id:          tx.id,
      type:        tx.type,
      amount:      tx.amount.toString(),
      description: tx.description,
      status:      tx.status,
      roundId:     tx.roundId,
      createdAt:   tx.createdAt.toISOString(),
    })),
  })
}