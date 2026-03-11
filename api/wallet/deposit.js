import { requireAuth }   from '../../lib/auth.js'
import { prisma }        from '../../lib/prisma.js'
import { handleCors }    from '../../lib/response.js'

const TORN_BASE = 'https://api.torn.com'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const { amount } = req.body ?? {}

  if (!amount || typeof amount !== 'number') { res.status(400).json({ error: 'Amount must be a number.' }); return }
  if (amount < 1000)                         { res.status(400).json({ error: 'Minimum deposit is $1,000.' }); return }
  if (amount > 2_000_000_000)                { res.status(400).json({ error: 'Amount too large.' }); return }

  const houseKey = process.env.HOUSE_API_KEY
  const houseId  = process.env.HOUSE_TORN_ID
  if (!houseKey || !houseId) { res.status(500).json({ error: 'Server misconfigured.' }); return }

  // Fetch house money log from Torn API
  let moneyLog
  try {
    const url  = `${TORN_BASE}/user/${houseId}?selections=moneylog&key=${houseKey}`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'TornNexus/1.0' },
      signal:  AbortSignal.timeout(8000),
    })
    if (!resp.ok) throw new Error(`Torn API HTTP ${resp.status}`)
    const data = await resp.json()
    if (data.error) throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`)
    moneyLog = data.moneylog ?? {}
  } catch (e) {
    res.status(502).json({ error: `Could not reach Torn API: ${e.message}` })
    return
  }

  // Scan log for a matching transfer from this player
  // Must match: sender_id = player's torn ID, amount >= claimed amount, not already used
  const entries = Object.entries(moneyLog)

  // Get all already-used torn tx IDs to avoid double credit
  const usedTxIds = new Set(
    (await prisma.transaction.findMany({
      where:  { tornTxId: { not: null } },
      select: { tornTxId: true },
    })).map(t => t.tornTxId)
  )

  // Find matching unused transaction
  const match = entries.find(([txId, tx]) => {
    if (usedTxIds.has(Number(txId)))             return false  // already credited
    if (Number(tx.sender_id) !== user.tornId)    return false  // wrong sender
    if (Number(tx.amount ?? 0) < amount)         return false  // amount too low
    return true
  })

  if (!match) {
    res.status(422).json({
      error: `No matching transfer found from your account for $${amount.toLocaleString()}. Make sure you sent the exact amount to the house account, then try again.`,
    })
    return
  }

  const [tornTxIdStr, tx] = match
  const tornTxId   = Number(tornTxIdStr)
  const amountBig  = BigInt(amount)

  // Double-check uniqueness at DB level before writing
  const existing = await prisma.transaction.findUnique({ where: { tornTxId } })
  if (existing) {
    res.status(400).json({ error: 'This transfer has already been credited.' })
    return
  }

  await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: user.id },
      data:  { balance: { increment: amountBig }, totalDeposited: { increment: amountBig } },
    }),
    prisma.transaction.create({
      data: {
        userId:      user.id,
        type:        'DEPOSIT',
        amount:      amountBig,
        description: `Deposit (tx #${tornTxId})`,
        tornTxId,
        status:      'COMPLETED',
      },
    }),
  ])

  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  res.status(200).json({
    message: `$${amount.toLocaleString()} deposited successfully.`,
    balance: wallet.balance.toString(),
  })
}
