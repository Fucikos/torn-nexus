// api/game/bet.js
// POST /api/game/bet
// Places a bet for the current round. Only allowed during BETTING phase.

import { requireAuth }         from '../../lib/auth.js'
import { prisma }              from '../../lib/prisma.js'
import { ok, err, handleCors } from '../../lib/response.js'

const MIN_BET = 100
const MAX_BET = 10_000_000

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
  if (amount < MIN_BET) return err(`Minimum bet is $${MIN_BET.toLocaleString()}.`)
  if (amount > MAX_BET) return err(`Maximum bet is $${MAX_BET.toLocaleString()}.`)

  const amountBig = BigInt(Math.floor(amount))

  // ── Validate game phase ────────────────────────────────────────────────
  const state = await prisma.gameState.findUnique({ where: { id: 1 } })
  if (!state || state.phase !== 'BETTING') {
    return err('Betting is closed for this round.', 409)
  }

  // ── Check balance ──────────────────────────────────────────────────────
  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  if (!wallet || wallet.balance < amountBig) {
    return err('Insufficient balance.', 422)
  }

  // ── Check no existing bet this round ──────────────────────────────────
  const existing = await prisma.bet.findUnique({
    where: {
      userId_roundId: { userId: user.id, roundId: state.roundId },
    },
  })
  if (existing) return err('You already have a bet this round.', 409)

  // ── Debit balance + create bet atomically ─────────────────────────────
  await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: user.id },
      data:  { balance: { decrement: amountBig } },
    }),
    prisma.bet.create({
      data: {
        userId:  user.id,
        roundId: state.roundId,
        amount:  amountBig,
        payout:  BigInt(0),
      },
    }),
  ])

  const updatedWallet = await prisma.wallet.findUnique({ where: { userId: user.id } })

  return ok({
    message: `Bet of $${amount.toLocaleString()} placed for round #${state.roundId}.`,
    balance: updatedWallet.balance.toString(),
    roundId: state.roundId,
  })
}
