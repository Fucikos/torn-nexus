import { requireAuth } from '../../lib/auth.js'
import { prisma }      from '../../lib/prisma.js'
import { handleCors }  from '../../lib/response.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return }

  const user = await requireAuth(req, res)
  if (!user) return

  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })

  res.status(200).json({
    id:       user.id,
    tornId:   user.tornId,
    username: user.username,
    balance:  wallet ? wallet.balance.toString() : '0',
  })
}