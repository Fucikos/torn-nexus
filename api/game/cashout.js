import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

const MIN_CASHOUT    = 1.10
const FEE_THRESHOLD  = 1.50
const FEE_RATE       = 0.03

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  // Read state and bet atomically together to minimise race window
  const state = await prisma.gameState.findUnique({ where: { id: 1 } })

  if (!state || state.phase !== 'RUNNING') {
    res.status(409).json({ error: 'Round is not in progress.' })
    return
  }

  // Double-check the Round table — the game server writes Round.phase = 'CRASHED'
  // BEFORE updating GameState, so this catches the 100ms crash boundary race
  const round = await prisma.round.findUnique({ where: { id: state.roundId } })
  if (!round || round.phase !== 'RUNNING') {
    res.status(409).json({ error: 'Round has already ended.' })
    return
  }

  const currentMult = parseFloat(state.multiplier.toString())

  if (currentMult < MIN_CASHOUT) {
    res.status(400).json({ error: `Minimum cash-out is ${MIN_CASHOUT}×` })
    return
  }

  const bet = await prisma.bet.findUnique({
    where: { userId_roundId: { userId: user.id, roundId: state.roundId } },
  })
  if (!bet)            { res.status(404).json({ error: 'No active bet found.' }); return }
  if (bet.cashoutMult) { res.status(409).json({ error: 'Already cashed out.' }); return }

  const rawPayout = BigInt(Math.floor(Number(bet.amount) * currentMult))
  const feeRate   = currentMult < FEE_THRESHOLD ? FEE_RATE : 0
  const fee       = BigInt(Math.floor(Number(rawPayout) * feeRate))
  const payout    = rawPayout - fee
  const profit    = payout - bet.amount

  const desc = fee > 0n
    ? `Cashed out at ${currentMult.toFixed(2)}× — Round #${state.roundId} (fee: $${fee.toString()})`
    : `Cashed out at ${currentMult.toFixed(2)}× — Round #${state.roundId}`

  // Write cashoutMult atomically — if the game server already set payout=0
  // (bust resolution) this will still succeed since cashoutMult was null,
  // but we check round.phase above which prevents that window.
  try {
    await prisma.$transaction([
      prisma.bet.update({
        where: { id: bet.id },
        data:  { cashoutMult: currentMult, payout, fee },
      }),
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
  } catch (e) {
    // If the bet was already resolved by the game server (bust) catch the conflict
    console.error('[cashout] transaction failed:', e.message)
    res.status(409).json({ error: 'Round ended before cashout could be processed.' })
    return
  }

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
