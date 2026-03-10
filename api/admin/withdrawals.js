import { prisma }        from '../../lib/prisma.js'
import { getHouseBalance } from '../../lib/tornApi.js'
import { handleCors }    from '../../lib/response.js'
import { compare }       from 'bcryptjs'

async function requireAdmin(req, res) {
  const header = req.headers['authorization'] ?? ''
  const pass   = header.replace('Bearer ', '').trim()
  if (!pass) { res.status(403).json({ error: 'Forbidden' }); return false }
  const valid = await compare(pass, process.env.ADMIN_PASSWORD_HASH ?? '')
  if (!valid) { res.status(403).json({ error: 'Forbidden' }); return false }
  return true
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return

  const isAdmin = await requireAdmin(req, res)
  if (!isAdmin) return

  if (req.method === 'GET') {
    const pending = await prisma.transaction.findMany({
      where: { type: 'WITHDRAWAL', status: 'PENDING' }, orderBy: { createdAt: 'asc' },
      include: { user: { select: { username: true, tornId: true } } },
    })
    let houseBalance = null
    try { houseBalance = await getHouseBalance() } catch {}
    res.status(200).json({
      houseBalance, pendingCount: pending.length,
      pendingTotalAmount: pending.reduce((s, t) => s + Number(t.amount), 0),
      withdrawals: pending.map(tx => ({ id: tx.id, amount: tx.amount.toString(), username: tx.user.username, tornId: tx.user.tornId, description: tx.description, createdAt: tx.createdAt.toISOString() })),
    })
    return
  }

  if (req.method === 'POST') {
    const { transactionId } = req.body ?? {}
    if (!transactionId) { res.status(400).json({ error: 'transactionId is required.' }); return }
    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } })
    if (!tx) { res.status(404).json({ error: 'Transaction not found.' }); return }
    if (tx.status === 'COMPLETED') { res.status(409).json({ error: 'Already completed.' }); return }
    await prisma.transaction.update({ where: { id: transactionId }, data: { status: 'COMPLETED' } })
    res.status(200).json({ message: `Withdrawal #${transactionId} marked as fulfilled.` })
    return
  }

  res.status(405).json({ error: 'Method not allowed' })
}