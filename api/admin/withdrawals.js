// api/admin/withdrawals.js
// GET  /api/admin/withdrawals         — list all pending withdrawals
// POST /api/admin/withdrawals/fulfill — mark a withdrawal as completed
//
// Protected by ADMIN_PASSWORD env var (not a user JWT).

import { prisma }              from '../../lib/prisma.js'
import { getHouseBalance }     from '../../lib/tornApi.js'
import { ok, err, handleCors } from '../../lib/response.js'
import { compare }             from 'bcryptjs'

/** Validate the admin Authorization header: Bearer <admin_password> */
async function requireAdmin(req) {
  const header = req.headers.get('authorization') ?? ''
  const pass   = header.replace('Bearer ', '').trim()
  if (!pass) return false

  // Compare against bcrypt hash stored in env
  const hash = process.env.ADMIN_PASSWORD_HASH ?? ''
  return compare(pass, hash)
}

export default async function handler(req) {
  const cors = handleCors(req)
  if (cors) return cors

  const isAdmin = await requireAdmin(req)
  if (!isAdmin) return err('Forbidden', 403)

  // ── GET: list pending withdrawals ─────────────────────────────────────
  if (req.method === 'GET') {
    const pending = await prisma.transaction.findMany({
      where:   { type: 'WITHDRAWAL', status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { username: true, tornId: true } } },
    })

    let houseBalance = null
    try {
      houseBalance = await getHouseBalance()
    } catch { /* non-fatal */ }

    return ok({
      houseBalance,
      pendingCount:       pending.length,
      pendingTotalAmount: pending.reduce((s, t) => s + Number(t.amount), 0),
      withdrawals: pending.map(tx => ({
        id:          tx.id,
        amount:      tx.amount.toString(),
        username:    tx.user.username,
        tornId:      tx.user.tornId,
        description: tx.description,
        createdAt:   tx.createdAt.toISOString(),
      })),
    })
  }

  // ── POST: fulfill a withdrawal ────────────────────────────────────────
  if (req.method === 'POST') {
    let body
    try { body = await req.json() } catch { return err('Invalid JSON') }

    const { transactionId } = body
    if (!transactionId) return err('transactionId is required.')

    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } })

    if (!tx)                   return err('Transaction not found.', 404)
    if (tx.type !== 'WITHDRAWAL') return err('Not a withdrawal transaction.', 400)
    if (tx.status === 'COMPLETED') return err('Already marked as completed.', 409)

    await prisma.transaction.update({
      where: { id: transactionId },
      data:  {
        status:      'COMPLETED',
        description: tx.description + ' — fulfilled',
      },
    })

    return ok({ message: `Withdrawal #${transactionId} marked as fulfilled.` })
  }

  return err('Method not allowed', 405)
}
