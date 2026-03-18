import { createHmac, createDecipheriv } from 'node:crypto'

// ── Payload builder ──────────────────────────────────────────

export function buildDeliveryPayload(
  eventId: string,
  channel: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: eventId,
    channel,
    timestamp: new Date().toISOString(),
    data,
  }
}

// ── HMAC signing ─────────────────────────────────────────────

export function signPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

// ── Secret decryption ────────────────────────────────────────

export function decryptSecret(blob: string): string {
  const key = process.env.WEBHOOK_SECRET_KEY
  if (!key || key.length < 32) throw new Error('WEBHOOK_SECRET_KEY required')
  const keyBuf = Buffer.from(key.slice(0, 32))
  const buf = Buffer.from(blob, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ciphertext = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

// ── SSRF check at delivery time ──────────────────────────────

const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^localhost$/i, /^::1$/, /^f[cd]/i, /^fe80/i,
]

export function isPrivateHost(hostname: string): boolean {
  return PRIVATE_RANGES.some((r) => r.test(hostname))
}

// ── HTTP delivery ────────────────────────────────────────────

export interface DeliveryResult {
  statusCode: number | null
  error: string | null
  delivered: boolean
  retryable: boolean
}

export async function deliverWebhook(
  url: string,
  body: string,
  signature: string,
  timeoutMs: number = 5000,
): Promise<DeliveryResult> {
  // SSRF check at delivery time
  try {
    const parsed = new URL(url)
    if (isPrivateHost(parsed.hostname)) {
      return { statusCode: null, error: `SSRF blocked: ${parsed.hostname}`, delivered: false, retryable: false }
    }
  } catch {
    return { statusCode: null, error: 'Invalid URL', delivered: false, retryable: false }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Oracle-Signature': signature,
      },
      body,
      signal: controller.signal,
      redirect: 'error', // Do not follow redirects
    })

    clearTimeout(timer)

    const statusCode = response.status
    if (statusCode >= 200 && statusCode < 300) {
      return { statusCode, error: null, delivered: true, retryable: false }
    }
    if (statusCode >= 400 && statusCode < 500) {
      return { statusCode, error: `Client error: ${statusCode}`, delivered: false, retryable: false }
    }
    // 5xx = retryable
    return { statusCode, error: `Server error: ${statusCode}`, delivered: false, retryable: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      statusCode: null,
      error: message,
      delivered: false,
      retryable: true, // network errors and timeouts are retryable
    }
  }
}
