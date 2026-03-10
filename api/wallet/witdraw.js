// api/wallet/withdraw.js
// POST /api/wallet/withdraw
// Debits the player's site balance and logs a PENDING withdrawal.
// The operator fulfills it manually in Torn, then marks it complete via admin panel.

import { requireAuth }         from '../../lib/auth.js'
import { prisma }              from '../../lib/prisma.js'
import { ok, err, handleCors } from '../../lib/response.js'

const MIN_WITHDRAWAL = 1_000

export default async function handler(req) {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'POST') return err('Method not allowed', 405)

  const user = await requireAuth(req)
  if (user instanceof Response) return user

  let body
  try { body = await req.json() } catch { return err('Invalid JSON body') }

  const { amount } = body

  if (!amount || typeof amount !== 'number') return err('amount must be a number.')
  if (amount < MIN_WITHDRAWAL) return err(`Minimum withdrawal is $${MIN_WITHDRAWAL.toLocaleString()}.`)

  const amountBig = BigInt(amount)

  // ── Check balance ──────────────────────────────────────────────────────
  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  if (!wallet) return err('Wallet not found.', 404)
  if (wallet.balance < amountBig) {
    return err(`Insufficient balance. You have $${wallet.balance.toLocaleString()}.`, 422)
  }

  // ── Debit + log as PENDING atomically ──────────────────────────────────
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
        description: `Withdrawal to Torn wallet — awaiting fulfillment`,
        status:      'PENDING',
      },
    }),
  ])

  return ok({
    message:       `Withdrawal of $${amount.toLocaleString()} requested. The operator will send it to your Torn account shortly.`,
    balance:       updatedWallet.balance.toString(),
    transactionId: tx.id,
  })
}
