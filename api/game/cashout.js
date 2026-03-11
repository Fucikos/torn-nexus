import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

const MIN_CASHOUT = 1.10   // minimum multiplier to cash out
const FEE_THRESHOLD = 1.50 // fee applies below this multiplier
const FEE_RATE = 0.03      // 3% fee on low multiplier cashouts

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const state = await prisma.gameState.findUnique({ where: { id: 1 } })
  if (!state || state.phase !== 'RUNNING') {
    res.status(409).json({ error: 'Round is not in progress.' }); return
  }

  const currentMult = parseFloat(state.multiplier.toString())

  // Enforce minimum cashout multiplier
  if (currentMult < MIN_CASHOUT) {
    res.status(400).json({ error: `Minimum cash-out is ${MIN_CASHOUT}×` }); return
  }

  const bet = await prisma.bet.findUnique({
    where: { userId_roundId: { userId: user.id, roundId: state.roundId } },
  })
  if (!bet)            { res.status(404).json({ error: 'No active bet found.' }); return }
  if (bet.cashoutMult) { res.status(409).json({ error: 'Already cashed out.' }); return }

  // Calculate payout with fee for low multipliers
  const rawPayout = BigInt(Math.floor(Number(bet.amount) * currentMult))
  const feeRate   = currentMult < FEE_THRESHOLD ? FEE_RATE : 0
  const fee       = BigInt(Math.floor(Number(rawPayout) * feeRate))
  const payout    = rawPayout - fee
  const profit    = payout - bet.amount

  const desc = fee > 0n
    ? `Cashed out at ${currentMult.toFixed(2)}× — Round #${state.roundId} (fee: $${fee.toString()})`
    : `Cashed out at ${currentMult.toFixed(2)}× — Round #${state.roundId}`

  // Atomically mark cashout only if not already cashed out (prevents race condition
  // where two simultaneous requests both pass the cashoutMult null-check above)
  const updateResult = await prisma.bet.updateMany({
    where: { id: bet.id, cashoutMult: null },
    data:  { cashoutMult: currentMult, payout },
  })

  if (updateResult.count === 0) {
    res.status(409).json({ error: 'Already cashed out.' }); return
  }

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
    message:     `Cashed out at ${currentMult.toFixed(2)}×!`,
    cashoutMult: currentMult.toFixed(2),
    payout:      payout.toString(),
    profit:      profit.toString(),
    fee:         fee.toString(),
    balance:     updatedWallet.balance.toString(),
  })
}
