import { randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto'

// ── Webhook secret generation ────────────────────────────────

export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

// ── AES-256-GCM encryption for stored secrets ────────────────

function getEncryptionKey(): Buffer {
  const key = process.env.WEBHOOK_SECRET_KEY
  if (!key || key.length < 32) throw new Error('WEBHOOK_SECRET_KEY must be at least 32 characters')
  return Buffer.from(key.slice(0, 32))
}

export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decryptSecret(blob: string): string {
  const key = getEncryptionKey()
  const buf = Buffer.from(blob, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ciphertext = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

// ── HMAC-SHA256 webhook signing ──────────────────────────────

export function signWebhookPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

export function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  const expected = signWebhookPayload(body, secret)
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

// ── SSRF URL validation ──────────────────────────────────────

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^localhost$/i,
  /^::1$/,
  /^f[cd]/i, // fc00::/7
  /^fe80/i,  // fe80::/10
]

export function validateWebhookUrl(url: string): { valid: boolean; error?: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'HTTPS required for webhook URLs' }
  }

  const hostname = parsed.hostname
  for (const pattern of PRIVATE_RANGES) {
    if (pattern.test(hostname)) {
      return { valid: false, error: `Webhook URL cannot target private/reserved address: ${hostname}` }
    }
  }

  return { valid: true }
}
