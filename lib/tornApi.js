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
    signal:  AbortSignal.timeout(8000),
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
 * @param {number} senderTornId   - The player's Torn ID
 * @param {number} expectedAmount - Amount the player claims to have sent
 * @param {number} tornTxId       - The transaction log ID from the player's event log
 */
export async function verifyDeposit(senderTornId, expectedAmount, tornTxId) {
  const houseKey  = process.env.HOUSE_API_KEY
  const houseId   = process.env.HOUSE_TORN_ID
  if (!houseKey) throw new Error('House API key not configured.')
  if (!houseId)  throw new Error('House Torn ID not configured.')

  // Fetch the house account's money log — this is where received transfers appear
  const data = await tornFetch(
    `user/${houseId}?selections=moneylog`,
    houseKey
  )

  const moneyLog = data.moneylog ?? {}

  // Look up the specific transaction by ID
  const tx = moneyLog[tornTxId.toString()]

  if (!tx) {
    return {
      ok:     false,
      reason: 'Transaction ID not found in house account. Make sure you sent the money and are using the correct transaction ID.',
    }
  }

  // Must be a received transfer (not sent)
  if (tx.type && tx.type !== 'Received') {
    return { ok: false, reason: 'Transaction is not a received transfer.' }
  }

  // Sender must match exactly — prevent one player using another's tx ID
  if (tx.sender_id && Number(tx.sender_id) !== Number(senderTornId)) {
    return { ok: false, reason: 'Transaction was not sent by your account.' }
  }

  // Amount received must be >= what they claim
  const receivedAmount = Number(tx.amount ?? tx.money_balance ?? 0)
  if (receivedAmount < expectedAmount) {
    return {
      ok:     false,
      reason: `Amount received ($${receivedAmount.toLocaleString()}) is less than claimed ($${expectedAmount.toLocaleString()}).`,
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
