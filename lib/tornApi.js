// lib/tornApi.js
// All Torn API calls happen here — never in client code.

const TORN_BASE = 'https://api.torn.com'

/**
 * Generic Torn API fetcher with error handling.
 */
async function tornFetch(path, apiKey) {
  const url  = `${TORN_BASE}/${path}&key=${apiKey}`
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'TornNexus/1.0' },
    signal:  AbortSignal.timeout(8000), // 8s timeout
  })

  if (!resp.ok) throw new Error(`Torn API HTTP ${resp.status}`)

  const data = await resp.json()
  if (data.error) throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`)

  return data
}

/**
 * Verify a player's identity using their own limited API key.
 * Returns { tornId, username, moneyOnHand } or throws.
 */
export async function verifyPlayerIdentity(username, apiKey) {
  const data = await tornFetch('user/?selections=basic,money', apiKey)

  if (!data.name) throw new Error('Could not retrieve player name from Torn.')

  if (data.name.toLowerCase() !== username.toLowerCase()) {
    throw new Error(`API key belongs to "${data.name}", not "${username}".`)
  }

  return {
    tornId:      data.player_id,
    username:    data.name,
    moneyOnHand: data.money_onhand ?? 0,
  }
}

/**
 * Verify that the house account received a specific transaction.
 * Uses the HOUSE API KEY (server env only).
 *
 * @param {number} senderTornId  - The player's Torn ID
 * @param {number} expectedAmount
 * @param {number} tornTxId      - The transaction ID from the player's event log
 */
export async function verifyDeposit(senderTornId, expectedAmount, tornTxId) {
  const houseKey = process.env.HOUSE_API_KEY
  if (!houseKey) throw new Error('House API key not configured.')

  // Fetch the house account's received money log
  const data = await tornFetch(
    `user/${process.env.HOUSE_TORN_ID}?selections=money,events`,
    houseKey
  )

  // Look for the specific transaction in events
  const events = data.events ?? {}
  const event  = Object.values(events).find(
    (e) =>
      e.event &&
      e.event.includes('received') &&
      e.event.includes(senderTornId.toString())
  )

  // Also check moneyoffered if available
  const moneyLog = data.moneyoffered ?? {}
  const tx = moneyLog[tornTxId]

  if (!tx && !event) {
    return { ok: false, reason: 'Transaction not found in house account logs.' }
  }

  const found = tx ?? event

  // Validate sender
  if (tx && tx.sender_id && tx.sender_id !== senderTornId) {
    return { ok: false, reason: 'Transaction sender does not match your account.' }
  }

  // Validate amount (allow higher amount — credit what was declared, not overage)
  if (tx && tx.amount && tx.amount < expectedAmount) {
    return {
      ok: false,
      reason: `Transaction amount ($${tx.amount.toLocaleString()}) is less than claimed ($${expectedAmount.toLocaleString()}).`,
    }
  }

  return { ok: true, verifiedAmount: expectedAmount }
}

/**
 * Get the house account's current Torn $ balance.
 * Used for admin dashboard.
 */
export async function getHouseBalance() {
  const data = await tornFetch(
    `user/${process.env.HOUSE_TORN_ID}?selections=money`,
    process.env.HOUSE_API_KEY
  )
  return data.money_onhand ?? 0
}
