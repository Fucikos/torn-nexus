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

  // Fetch house money log (type 4801 = money received) from Torn API
  let logEntries
  try {
    const url  = `${TORN_BASE}/user/${houseId}?selections=log&log=4801&key=${houseKey}`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'TornNexus/1.0' },
      signal:  AbortSignal.timeout(8000),
    })
    if (!resp.ok) throw new Error(`Torn API HTTP ${resp.status}`)
    const data = await resp.json()
    if (data.error) throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`)
    // log returns an object keyed by hash string (tornTxKey)
    logEntries = Object.entries(data.log ?? {})
  } catch (e) {
    res.status(502).json({ error: `Could not reach Torn API: ${e.message}` })
    return
  }

  if (logEntries.length === 0) {
    res.status(422).json({ error: 'No recent money transfers found on house account. Please send the Torn $ first, then deposit.' })
    return
  }

  // Get all already-used tornTxKey values to prevent double-credit
  // Schema: Transaction.tornTxKey String? @unique
  const usedKeys = new Set(
    (await prisma.transaction.findMany({
      where:  { tornTxKey: { not: null } },
      select: { tornTxKey: true },
    })).map(t => t.tornTxKey)
  )

  // Scan log for a matching unused transfer from this player
  // Log entry shape: { data: { sender: tornId, money: amount, ... }, timestamp: ... }
  const match = logEntries.find(([txKey, entry]) => {
    if (usedKeys.has(txKey))                              return false // already credited
    if (Number(entry.data?.sender) !== user.tornId)       return false // wrong sender
    if (Number(entry.data?.money ?? 0) < amount)          return false // amount too low
    return true
  })

  if (!match) {
    res.status(422).json({
      error: `No matching transfer found from your account (Torn ID: ${user.tornId}) for $${amount.toLocaleString()}. ` +
             `Make sure you sent the Torn $ to the house account first, then click Deposit again.`,
    })
    return
  }

  const [tornTxKey, entry] = match
  const amountBig = BigInt(Math.floor(amount))

  // Atomic double-credit guard at DB level (tornTxKey has @unique constraint)
  try {
    await prisma.$transaction([
      prisma.wallet.update({
        where: { userId: user.id },
        data:  {
          balance:        { increment: amountBig },
          totalDeposited: { increment: amountBig },
        },
      }),
      prisma.transaction.create({
        data: {
          userId:      user.id,
          type:        'DEPOSIT',
          amount:      amountBig,
          description: `Deposit from Torn transfer`,
          tornTxKey,              // String @unique — blocks any duplicate
          status:      'COMPLETED',
        },
      }),
    ])
  } catch (e) {
    // Unique constraint violation = duplicate attempt
    if (e.code === 'P2002') {
      res.status(400).json({ error: 'This transfer has already been credited to an account.' })
      return
    }
    throw e
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  res.status(200).json({
    message: `$${amount.toLocaleString()} deposited successfully! Your balance has been updated.`,
    balance: wallet.balance.toString(),
  })
}
