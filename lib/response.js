// lib/response.js
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export function ok(res, data, status = 200) {
  res.status(status).json(data)
}

export function err(res, message, status = 400) {
  res.status(status).json({ error: message })
}

export function handleCors(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return true
  }
  return false
}