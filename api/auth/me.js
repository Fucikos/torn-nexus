// api/auth/login.js
// POST /api/auth/login
// Verifies the player via Torn API and issues a JWT.

import { prisma }               from '../../lib/prisma.js'
import { signToken }             from '../../lib/auth.js'
import { encrypt }               from '../../lib/crypto.js'
import { verifyPlayerIdentity }  from '../../lib/tornApi.js'
import { ok, err, handleCors }   from '../../lib/response.js'

export default async function handler(req) {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'POST') return err('Method not allowed', 405)

  let body
  try {
    body = await req.json()
  } catch {
    return err('Invalid JSON body')
  }

  const { username, apiKey } = body

  if (!username || typeof username !== 'string') return err('Username is required.')
  if (!apiKey   || typeof apiKey   !== 'string') return err('API key is required.')
  if (apiKey.length < 16)                        return err('API key is too short.')

  // ── Step 1: Verify identity with Torn API ──────────────────────────────
  let tornData
  try {
    tornData = await verifyPlayerIdentity(username, apiKey)
  } catch (e) {
    return err(e.message, 401)
  }

  // ── Step 2: Upsert user in database ───────────────────────────────────
  const encryptedKey = encrypt(apiKey)

  const user = await prisma.user.upsert({
    where:  { tornId: tornData.tornId },
    update: {
      username:     tornData.username,
      encryptedKey,
      lastSeen:     new Date(),
    },
    create: {
      tornId:       tornData.tornId,
      username:     tornData.username,
      encryptedKey,
      wallet: {
        create: {
          balance:        BigInt(0),
          totalDeposited: BigInt(0),
          totalWithdrawn: BigInt(0),
        },
      },
    },
    include: { wallet: true },
  })

  // ── Step 3: Issue JWT (never include the API key) ─────────────────────
  const token = await signToken({
    id:       user.id,
    tornId:   user.tornId,
    username: user.username,
  })

  return ok({
    token,
    user: {
      id:       user.id,
      tornId:   user.tornId,
      username: user.username,
      balance:  user.wallet ? user.wallet.balance.toString() : '0',
    },
  })
}
