// lib/crypto.js
// AES-256-GCM encryption for storing player API keys in the database.
// The ENCRYPTION_KEY env var must be a 64-char hex string (32 bytes).

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'hex')

/**
 * Encrypt a plaintext string.
 * Returns a single string: hex(iv):hex(authTag):hex(ciphertext)
 */
export function encrypt(plaintext) {
  const iv         = randomBytes(12)                       // 96-bit IV for GCM
  const cipher     = createCipheriv(ALGORITHM, KEY, iv)
  const encrypted  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag    = cipher.getAuthTag()

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':')
}

/**
 * Decrypt a string produced by encrypt().
 */
export function decrypt(encoded) {
  const [ivHex, authTagHex, ciphertextHex] = encoded.split(':')
  const iv         = Buffer.from(ivHex, 'hex')
  const authTag    = Buffer.from(authTagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextHex, 'hex')

  const decipher = createDecipheriv(ALGORITHM, KEY, iv)
  decipher.setAuthTag(authTag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
