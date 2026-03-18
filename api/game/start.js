// api/game/start.js
// Player places a bet and a new Game row is created with a server-side seed.
// The seed pre-determines all 8 outcomes but is never sent to the client.

import { requireAuth }                       from '../../lib/auth.js'
import { prisma }                            from '../../lib/prisma.js'
import { handleCors }                        from '../../lib/response.js'
import { MIN_BET, MAX_BET, generateOutcomes, survivalProbability } from '../../lib/gameLogic.js'
import { randomBytes }                       from 'crypto'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  // ── Validate amount ──────────────────────────────────────────────────────────
  const rawAmount = req.body?.amount
  const amount    = typeof rawAmount === 'number' ? rawAmount : parseFloat(rawAmount)

  if (!amount || isNaN(amount) || amount <= 0) {
    res.status(400).json({ error: 'Amount must be a positive number.' }); return
  }
  if (amount < MIN_BET) {
    res.status(400).json({ error: `Minimum bet is $${MIN_BET.toLocaleString()}.` }); return
  }
  if (amount > MAX_BET) {
    res.status(400).json({ error: `Maximum bet is $${MAX_BET.toLocaleString()}.` }); return
  }

  const amountBig = BigInt(Math.floor(amount))

  // ── Guard: no active game already ───────────────────────────────────────────
  const activeGame = await prisma.game.findFirst({
    where: { userId: user.id, status: 'ACTIVE' },
  })
  if (activeGame) {
    res.status(409).json({ error: 'You already have an active game. Step or cash out first.', gameId: activeGame.id })
    return
  }

  // ── Balance check ────────────────────────────────────────────────────────────
  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  if (!wallet || wallet.balance < amountBig) {
    res.status(422).json({ error: 'Insufficient balance.' }); return
  }

  // ── Generate server-side seed (never sent to client) ────────────────────────
  const seed = randomBytes(32).toString('hex')

  // ── Atomic: debit wallet + create game ──────────────────────────────────────
  const [, game] = await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: user.id },
      data:  { balance: { decrement: amountBig } },
    }),
    prisma.game.create({
      data: {
        userId:    user.id,
        betAmount: amountBig,
        seed,
        status:    'ACTIVE',
      },
    }),
  ])

  const updatedWallet = await prisma.wallet.findUnique({ where: { userId: user.id } })

  res.status(200).json({
    gameId:       game.id,
    betAmount:    amountBig.toString(),
    stepsReached: 0,
    status:       'ACTIVE',
    balance:      updatedWallet.balance.toString(),
    // Send the multiplier ladder so client can display upcoming rewards
    multipliers:  [1.00, 1.25, 1.55, 1.90, 2.35, 2.85, 3.45, 4.15, 5.00],
  })
}
