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

  // Fetch house money log (type 4810 = money received) from Torn API
  // Using /user/?selections=log queries the key owner's own log
  let logEntries
  try {
    const url  = `${TORN_BASE}/user/?selections=log&log=4810&key=${houseKey}`
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
  // Log entry shape: { log: 4810, data: { sender: tornId, money: amount, anonymous, message } }
  // Sort by most recent first (highest timestamp wins) so we credit the latest matching tx
  const sortedEntries = logEntries.sort(([, a], [, b]) => (b.timestamp ?? 0) - (a.timestamp ?? 0))

  const match = sortedEntries.find(([txKey, entry]) => {
    if (entry.log !== 4810)                                return false // only money-receive entries
    if (usedKeys.has(txKey))                               return false // already credited
    if (Number(entry.data?.sender) !== user.tornId)        return false // wrong sender
    // Allow player to claim any amount <= what was actually sent
    // (they may deposit partial amounts from a larger transfer)
    if (Number(entry.data?.money ?? 0) < amount)           return false // sent less than claimed
    return true
  })

  if (!match) {
    // Debug: log what we actually got so Railway logs show the mismatch
    const sample = logEntries.slice(0, 5).map(([k, e]) => ({
      key: k, logType: e.log, sender: e.data?.sender, money: e.data?.money, used: usedKeys.has(k),
    }))
    console.error('[deposit] No match. tornId:', user.tornId, 'amount:', amount,
      'entries:', logEntries.length, 'sample:', JSON.stringify(sample))

    res.status(422).json({
      error: `No matching transfer found from Torn ID ${user.tornId} for $${amount.toLocaleString()}. ` +
             `We scanned ${logEntries.length} recent receive entries. ` +
             `Ensure you sent the exact amount to the house account, then try again.`,
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
