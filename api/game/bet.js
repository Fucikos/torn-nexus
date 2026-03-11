import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const rawAmount = req.body?.amount
  const amount    = typeof rawAmount === 'number' ? rawAmount : parseFloat(rawAmount)

  if (!amount || isNaN(amount) || amount <= 0) { res.status(400).json({ error: 'amount must be a number.' }); return }
  if (amount < 100)      { res.status(400).json({ error: 'Minimum bet is $100.' }); return }
  if (amount > 10000000) { res.status(400).json({ error: 'Maximum bet is $10,000,000.' }); return }

  const amountBig = BigInt(Math.floor(amount))

  const state = await prisma.gameState.findUnique({ where: { id: 1 } })

  // Must be BETTING phase specifically — COOLDOWN phase also has roundId set but is NOT open
  if (!state || state.phase !== 'BETTING') {
    res.status(409).json({ error: 'Betting is closed for this round.' })
    return
  }

  // Verify the round itself is still in BETTING phase (double-check against Round table)
  const round = await prisma.round.findUnique({ where: { id: state.roundId } })
  if (!round || round.phase !== 'BETTING') {
    res.status(409).json({ error: 'Betting is closed for this round.' })
    return
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  if (!wallet || wallet.balance < amountBig) {
    res.status(422).json({ error: 'Insufficient balance.' })
    return
  }

  // Check for existing bet on this round
  const existing = await prisma.bet.findUnique({
    where: { userId_roundId: { userId: user.id, roundId: state.roundId } },
  })
  if (existing) {
    res.status(409).json({ error: 'You already have a bet this round.' })
    return
  }

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
    message:  `Bet placed for round #${state.roundId}.`,
    balance:  updatedWallet.balance.toString(),
    roundId:  state.roundId,
  })
}
