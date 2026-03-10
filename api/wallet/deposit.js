import { requireAuth }    from '../../lib/auth.js'
import { prisma }         from '../../lib/prisma.js'
import { verifyDeposit }  from '../../lib/tornApi.js'
import { handleCors }     from '../../lib/response.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const { amount, tornTxId } = req.body ?? {}

  if (!amount || typeof amount !== 'number')     { res.status(400).json({ error: 'amount must be a number.' }); return }
  if (!tornTxId || typeof tornTxId !== 'number') { res.status(400).json({ error: 'tornTxId must be a number.' }); return }
  if (amount < 1000)                             { res.status(400).json({ error: 'Minimum deposit is $1,000.' }); return }

  const existing = await prisma.transaction.findUnique({ where: { tornTxId } })
  if (existing) { res.status(400).json({ error: 'This transaction has already been credited.' }); return }

  let verification
  try {
    verification = await verifyDeposit(user.tornId, amount, tornTxId)
  } catch (e) {
    res.status(502).json({ error: `Torn API error: ${e.message}` })
    return
  }

  if (!verification.ok) { res.status(422).json({ error: verification.reason }); return }

  const amountBig = BigInt(amount)

  await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: user.id },
      data: { balance: { increment: amountBig }, totalDeposited: { increment: amountBig } },
    }),
    prisma.transaction.create({
      data: { userId: user.id, type: 'DEPOSIT', amount: amountBig, description: `Deposit (tx #${tornTxId})`, tornTxId, status: 'COMPLETED' },
    }),
  ])

  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  res.status(200).json({ message: `$${amount.toLocaleString()} deposited successfully.`, balance: wallet.balance.toString() })
}