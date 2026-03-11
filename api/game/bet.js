// api/game/bet.js
import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

const MIN_BET = 100
const MAX_BET = 10_000_000

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  // Coerce amount to a clean integer
  const rawAmount = req.body?.amount
  const amount    = typeof rawAmount === 'number' ? rawAmount : parseFloat(rawAmount)

  if (!amount || isNaN(amount) || amount <= 0) { res.status(400).json({ error: 'amount must be a positive number.' }); return }
  if (amount < MIN_BET) { res.status(400).json({ error: `Minimum bet is $${MIN_BET.toLocaleString()}.` }); return }
  if (amount > MAX_BET) { res.status(400).json({ error: `Maximum bet is $${MAX_BET.toLocaleString()}.` }); return }

  const amountBig = BigInt(Math.floor(amount))

  // ── Phase check ────────────────────────────────────────────────────────────
  // Only accept bets in the BETTING phase.
  // COOLDOWN and CRASHED are both closed — never allow betting against a
  // round that is already running or finished.
  const state = await prisma.gameState.findUnique({ where: { id: 1 } })
  if (!state || state.phase !== 'BETTING') {
    res.status(409).json({ error: 'Betting is closed — wait for the next round.' })
    return
  }

  // Double-check the Round row itself is still in BETTING state
  const round = await prisma.round.findUnique({ where: { id: state.roundId } })
  if (!round || round.phase !== 'BETTING') {
    res.status(409).json({ error: 'Betting is closed — round has already started.' })
    return
  }

  // ── Balance check ──────────────────────────────────────────────────────────
  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  if (!wallet || wallet.balance < amountBig) {
    res.status(422).json({ error: 'Insufficient balance.' })
    return
  }

  // ── Duplicate bet guard ────────────────────────────────────────────────────
  const existing = await prisma.bet.findUnique({
    where: { userId_roundId: { userId: user.id, roundId: state.roundId } },
  })
  if (existing) {
    res.status(409).json({ error: 'You already have a bet this round.' })
    return
  }

  // ── Atomic debit + bet creation ────────────────────────────────────────────
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
  res.status(200).json({
    message: `Bet of $${Math.floor(amount).toLocaleString()} placed for round #${state.roundId}.`,
    balance: updatedWallet.balance.toString(),
    roundId: state.roundId,
  })
}
