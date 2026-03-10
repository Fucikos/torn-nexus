import { prisma }              from '../../lib/prisma.js'
import { signToken }           from '../../lib/auth.js'
import { encrypt }             from '../../lib/crypto.js'
import { verifyPlayerIdentity } from '../../lib/tornApi.js'
import { ok, err, handleCors } from '../../lib/response.js'

export default async function handler(req, res) {
  const cors = handleCors(req, res)
  if (cors) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const { username, apiKey } = req.body ?? {}

  if (!username) { res.status(400).json({ error: 'Username is required.' }); return }
  if (!apiKey)   { res.status(400).json({ error: 'API key is required.' });  return }
  if (apiKey.length < 16) { res.status(400).json({ error: 'API key is too short.' }); return }

  let tornData
  try {
    tornData = await verifyPlayerIdentity(username, apiKey)
  } catch (e) {
    res.status(401).json({ error: e.message })
    return
  }

  const encryptedKey = encrypt(apiKey)

  const user = await prisma.user.upsert({
    where:  { tornId: tornData.tornId },
    update: { username: tornData.username, encryptedKey, lastSeen: new Date() },
    create: {
      tornId: tornData.tornId,
      username: tornData.username,
      encryptedKey,
      wallet: {
        create: {
          balance: BigInt(0),
          totalDeposited: BigInt(0),
          totalWithdrawn: BigInt(0),
        },
      },
    },
    include: { wallet: true },
  })

  const token = await signToken({ id: user.id, tornId: user.tornId, username: user.username })

  res.status(200).json({
    token,
    user: {
      id:       user.id,
      tornId:   user.tornId,
      username: user.username,
      balance:  user.wallet ? user.wallet.balance.toString() : '0',
    },
  })
}