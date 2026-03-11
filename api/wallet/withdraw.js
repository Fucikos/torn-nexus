import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  // Coerce to number — frontend may send string from input value
  const rawAmount = req.body?.amount
  const amount    = typeof rawAmount === 'string' ? parseFloat(rawAmount) : Number(rawAmount ?? 0)

  if (!amount || isNaN(amount) || amount <= 0) { res.status(400).json({ error: 'Amount must be a positive number.' }); return }
  if (amount < 1000)                            { res.status(400).json({ error: 'Minimum withdrawal is $1,000.' }); return }
  if (amount > 2_000_000_000)                   { res.status(400).json({ error: 'Amount too large.' }); return }

  const amountBig = BigInt(Math.floor(amount))

  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  if (!wallet)                       { res.status(404).json({ error: 'Wallet not found.' }); return }
  if (wallet.balance < amountBig)    { res.status(422).json({ error: `Insufficient balance. You have $${Number(wallet.balance).toLocaleString()} available.` }); return }

  const [updatedWallet, tx] = await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: user.id },
      data: {
        balance:        { decrement: amountBig },
        totalWithdrawn: { increment: amountBig },
      },
    }),
    prisma.transaction.create({
      data: {
        userId:      user.id,
        type:        'WITHDRAWAL',
        amount:      amountBig,
        description: `Withdrawal of $${Math.floor(amount).toLocaleString()} — pending fulfillment`,
        status:      'PENDING',
      },
    }),
  ])

  res.status(200).json({
    message:       `Withdrawal of $${Math.floor(amount).toLocaleString()} submitted. The operator will send your Torn $ within 24 hours.`,
    balance:       updatedWallet.balance.toString(),
    transactionId: tx.id,
  })
}
