// api/wallet/index.js
// Wallet router — handles GET /api/wallet (balance + transactions)
// Deposit and withdraw live in their own files: deposit.js, withdraw.js

import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

const TX_LIMIT = 50

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const wallet = await prisma.wallet.findUnique({
    where: { userId: user.id },
  })

  if (!wallet) {
    res.status(404).json({ error: 'Wallet not found.' })
    return
  }

  const transactions = await prisma.transaction.findMany({
    where:   { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take:    TX_LIMIT,
  })

  res.status(200).json({
    balance:        wallet.balance.toString(),
    totalDeposited: wallet.totalDeposited.toString(),
    totalWithdrawn: wallet.totalWithdrawn.toString(),
    transactions:   transactions.map(tx => ({
      id:          tx.id,
      type:        tx.type,
      amount:      tx.amount.toString(),
      description: tx.description ?? '',
      status:      tx.status,
      createdAt:   tx.createdAt.toISOString(),
    })),
  })
}
