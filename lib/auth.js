import { SignJWT, jwtVerify } from 'jose'

const secret = new TextEncoder().encode(process.env.JWT_SECRET)

export async function signToken(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret)
}

export async function verifyToken(req) {
  try {
    const authHeader = req.headers['authorization'] ?? ''
    const token = authHeader.replace('Bearer ', '').trim()
    if (!token) return null
    const { payload } = await jwtVerify(token, secret)
    return payload
  } catch {
    return null
  }
}

export async function requireAuth(req, res) {
  const user = await verifyToken(req)
  if (!user) {
    res.status(401).json({ error: 'Unauthorised' })
    return null
  }
  return user
}