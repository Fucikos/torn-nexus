// api/wallet/deposit.js
// POST /api/wallet/deposit
// Player submits the Torn transaction ID after sending $ to the house account.
// Server verifies via Torn API before crediting any balance.

import { requireAuth }         from '../../lib/auth.js'
import { prisma }              from '../../lib/prisma.js'
import { verifyDeposit }       from '../../lib/tornApi.js'
import { ok, err, handleCors } from '../../lib/response.js'

const MIN_DEPOSIT = 1_000    // $1,000 minimum
const MAX_DEPOSIT = 10_000_000_000 // $10B maximum

export default async function handler(req) {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'POST') return err('Method not allowed', 405)

  const user = await requireAuth(req)
  if (user instanceof Response) return user

  let body
  try { body = await req.json() } catch { return err('Invalid JSON body') }

  const { amount, tornTxId } = body

  // ── Validate inputs ────────────────────────────────────────────────────
  if (!amount || typeof amount !== 'number')   return err('amount must be a number.')
  if (!tornTxId || typeof tornTxId !== 'number') return err('tornTxId must be a number.')
  if (amount < MIN_DEPOSIT) return err(`Minimum deposit is $${MIN_DEPOSIT.toLocaleString()}.`)
  if (amount > MAX_DEPOSIT) return err('Amount exceeds maximum.')

  // ── Idempotency: check this tornTxId hasn't been credited before ───────
  const existing = await prisma.transaction.findUnique({
    where: { tornTxId },
  })
  if (existing) return err('This transaction has already been credited.')

  // ── Verify with Torn API ───────────────────────────────────────────────
  let verification
  try {
    verification = await verifyDeposit(user.tornId, amount, tornTxId)
  } catch (e) {
    return err(`Torn API error: ${e.message}`, 502)
  }

  if (!verification.ok) return err(verification.reason, 422)

  // ── Credit balance atomically ──────────────────────────────────────────
  const amountBig = BigInt(amount)

  await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: user.id },
      data: {
        balance:        { increment: amountBig },
        totalDeposited: { increment: amountBig },
      },
    }),
    prisma.transaction.create({
      data: {
        userId:      user.id,
        type:        'DEPOSIT',
        amount:      amountBig,
        description: `Deposit from Torn wallet (tx #${tornTxId})`,
        tornTxId,
        status:      'COMPLETED',
      },
    }),
  ])

  // Return updated balance
  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })

  return ok({
    message: `$${amount.toLocaleString()} deposited successfully.`,
    balance: wallet.balance.toString(),
  })
}
