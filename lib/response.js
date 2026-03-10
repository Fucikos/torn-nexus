// lib/response.js
// Consistent JSON response helpers + CORS for all API routes.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
}

export function ok(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS })
}

export function err(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers: CORS_HEADERS })
}

/** Call at the top of every route handler to handle CORS preflight. */
export function handleCors(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  return null
}
