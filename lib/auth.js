// lib/auth.js
// JWT sign / verify using the 'jose' library (Edge + Node compatible)

import { SignJWT, jwtVerify } from 'jose'

const secret = new TextEncoder().encode(process.env.JWT_SECRET)

/**
 * Sign a JWT for a logged-in user.
 * @param {{ id: number, tornId: number, username: string }} payload
 * @returns {Promise<string>} signed JWT
 */
export async function signToken(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret)
}

/**
 * Verify and decode a JWT from the Authorization header.
 * @param {Request} req
 * @returns {Promise<object|null>} decoded payload or null if invalid
 */
export async function verifyToken(req) {
  try {
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.replace('Bearer ', '').trim()
    if (!token) return null
    const { payload } = await jwtVerify(token, secret)
    return payload
  } catch {
    return null
  }
}

/**
 * Middleware helper — returns 401 response if token is invalid.
 * Usage: const user = await requireAuth(req); if (user instanceof Response) return user;
 */
export async function requireAuth(req) {
  const user = await verifyToken(req)
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorised' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return user
}
