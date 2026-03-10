import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const { amount } = req.body ?? {}
  if (!amount || typeof amount !== 'number') { res.status(400).json({ error: 'amount must be a number.' }); return }
  if (amount < 1000) { res.status(400).json({ error: 'Minimum withdrawal is $1,000.' }); return }

  const amountBig = BigInt(amount)
  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  if (!wallet) { res.status(404).json({ error: 'Wallet not found.' }); return }
  if (wallet.balance < amountBig) { res.status(422).json({ error: 'Insufficient balance.' }); return }

  const [updatedWallet, tx] = await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: user.id },
      data: { balance: { decrement: amountBig }, totalWithdrawn: { increment: amountBig } },
    }),
    prisma.transaction.create({
      data: { userId: user.id, type: 'WITHDRAWAL', amount: amountBig, description: 'Withdrawal — awaiting fulfillment', status: 'PENDING' },
    }),
  ])

  res.status(200).json({ message: `Withdrawal of $${amount.toLocaleString()} requested.`, balance: updatedWallet.balance.toString(), transactionId: tx.id })
}