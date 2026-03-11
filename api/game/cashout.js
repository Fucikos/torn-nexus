// api/game/cashout.js
import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

const MIN_CASHOUT_MULT = 1.10   // can't cash out below 1.10×
const FEE_THRESHOLD    = 1.50   // cashouts below this incur a small fee
const FEE_RATE         = 0.03   // 3% fee

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  // ── Phase check ────────────────────────────────────────────────────────────
  const state = await prisma.gameState.findUnique({ where: { id: 1 } })
  if (!state || state.phase !== 'RUNNING') {
    res.status(409).json({ error: 'Round is not in progress — too late to cash out.' })
    return
  }

  // ── Read server multiplier ─────────────────────────────────────────────────
  // The server multiplier written every 100ms tick is the authoritative value.
  // Use it (not the client-supplied value) to prevent cheating.
  const currentMult = parseFloat(state.multiplier.toString())

  if (currentMult < MIN_CASHOUT_MULT) {
    res.status(400).json({ error: `Minimum cash-out is ${MIN_CASHOUT_MULT}×. Wait a moment.` })
    return
  }

  // ── Find active bet ────────────────────────────────────────────────────────
  const bet = await prisma.bet.findUnique({
    where: { userId_roundId: { userId: user.id, roundId: state.roundId } },
  })
  if (!bet)            { res.status(404).json({ error: 'No active bet found for this round.' }); return }
  if (bet.cashoutMult) { res.status(409).json({ error: 'Already cashed out.' }); return }

  // ── Compute payout ─────────────────────────────────────────────────────────
  const rawPayout = BigInt(Math.floor(Number(bet.amount) * currentMult))
  const feeRate   = currentMult < FEE_THRESHOLD ? FEE_RATE : 0
  const fee       = BigInt(Math.floor(Number(rawPayout) * feeRate))
  const payout    = rawPayout - fee
  const profit    = payout - bet.amount   // can be negative if currentMult < 1.0 (edge case)

  const feeNote = fee > 0n
    ? ` (fee: $${fee.toString()})`
    : ''
  const desc = `Cashed out at ${currentMult.toFixed(4)}× — Round #${state.roundId}${feeNote}`

  // ── Atomic cashout guard ───────────────────────────────────────────────────
  // updateMany with cashoutMult: null ensures only one concurrent request wins.
  // If two simultaneous cashout requests both pass the findUnique check above,
  // only the first updateMany will match (count === 1); the second returns count 0.
  const updated = await prisma.bet.updateMany({
    where: { id: bet.id, cashoutMult: null },
    data:  { cashoutMult: currentMult, payout },
  })

  if (updated.count === 0) {
    res.status(409).json({ error: 'Already cashed out.' })
    return
  }

  // ── Credit wallet ──────────────────────────────────────────────────────────
  await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: user.id },
      data:  { balance: { increment: payout } },
    }),
    prisma.transaction.create({
      data: {
        userId:      user.id,
        type:        'BET_WIN',
        amount:      payout,
        description: desc,
        roundId:     state.roundId,
        status:      'COMPLETED',
      },
    }),
  ])

  const updatedWallet = await prisma.wallet.findUnique({ where: { userId: user.id } })

  res.status(200).json({
    message:     `Cashed out at ${currentMult.toFixed(4)}×!`,
    cashoutMult: currentMult.toFixed(4),
    payout:      payout.toString(),
    profit:      profit.toString(),
    fee:         fee.toString(),
    balance:     updatedWallet.balance.toString(),
  })
}
