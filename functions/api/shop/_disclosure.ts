import { getClientIp } from '../../_form-shared.ts'
import {
  createSellerAddressDisclosureServiceRequest,
  getDb,
  getSellerAddressDisclosureRuntime,
  hasSellerAddressDisclosureSchema,
  isSellerAddressDisclosureEmailServiceReady,
  isSellerAddressDisclosureRequestHostAllowed,
  ShopApiError,
  type D1Database,
  type SellerAddressDisclosureRuntime,
  type ShopEnv,
} from './_shared.ts'

export const SELLER_DISCLOSURE_TURNSTILE_ACTION = 'seller-disclosure'

const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const ATTEMPT_WINDOW_SECONDS = 10 * 60
const ATTEMPT_LIMIT = 20
const IP_SEND_WINDOW_SECONDS = 60 * 60
const IP_SEND_LIMIT = 5
const EMAIL_SEND_WINDOW_SECONDS = 24 * 60 * 60
const EMAIL_SEND_LIMIT = 3
const GLOBAL_SEND_WINDOW_SECONDS = 24 * 60 * 60
const GLOBAL_SEND_LIMIT = 100
const RETENTION_DAYS = 90
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type DisclosureRequestPayload = {
  requestId: string
  email: string
  turnstileToken: string
}

type DisclosureRequestRow = {
  id: string
  email_hash: string
  status: 'processing' | 'sent' | 'failed' | 'delivery_unknown'
}

type RateLimitRow = {
  request_count: number
}

type TurnstileResult = {
  success?: boolean
  hostname?: string
  action?: string
}

export type SellerDisclosurePublicConfig = {
  enabled: boolean
  siteKey?: string
  action?: string
}

export async function getSellerDisclosurePublicConfig(
  request: Request,
  env: ShopEnv,
): Promise<SellerDisclosurePublicConfig> {
  try {
    const runtime = getSellerAddressDisclosureRuntime(env, request)
    if (!runtime || !env.SHOP_DB || !env.TURNSTILE_SECRET_KEY) {
      return { enabled: false }
    }

    const schemaReady = await hasSellerAddressDisclosureSchema(env.SHOP_DB)
    if (!schemaReady) {
      console.warn(
        JSON.stringify({
          event: 'seller_disclosure_public_config_unavailable',
          schemaReady,
        }),
      )
      return { enabled: false }
    }

    const emailServiceReady =
      await isSellerAddressDisclosureEmailServiceReady(runtime)
    if (!emailServiceReady) {
      console.warn(
        JSON.stringify({
          event: 'seller_disclosure_public_config_unavailable',
          schemaReady,
          emailServiceReady,
        }),
      )
      return { enabled: false }
    }

    return {
      enabled: true,
      siteKey: runtime.turnstileSiteKey,
      action: SELLER_DISCLOSURE_TURNSTILE_ACTION,
    }
  } catch {
    return { enabled: false }
  }
}

export function assertSellerDisclosureRequestOrigin(
  request: Request,
  env: ShopEnv,
) {
  const requestUrl = new URL(request.url)
  const origin = request.headers.get('Origin')
  const isLocal =
    requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1'

  if (
    !origin ||
    origin !== requestUrl.origin ||
    !isSellerAddressDisclosureRequestHostAllowed(request, env) ||
    (!isLocal && requestUrl.protocol !== 'https:')
  ) {
    throw new ShopApiError(403, 'この送信元からは受け付けられません。')
  }
}

export function validateSellerDisclosureRequest(
  value: unknown,
): DisclosureRequestPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest()
  }

  const payload = value as Record<string, unknown>
  const allowedKeys = new Set([
    'requestId',
    'email',
    'consent',
    'turnstileToken',
    'website',
  ])
  if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
    throw invalidRequest()
  }

  const requestId = String(payload.requestId || '').trim()
  const email = String(payload.email || '')
    .trim()
    .toLowerCase()
  const turnstileToken = String(payload.turnstileToken || '').trim()

  if (
    !UUID_PATTERN.test(requestId) ||
    !EMAIL_PATTERN.test(email) ||
    email.length > 254 ||
    payload.consent !== true ||
    !turnstileToken ||
    turnstileToken.length > 2048 ||
    String(payload.website || '').trim()
  ) {
    throw invalidRequest()
  }

  return { requestId, email, turnstileToken }
}

export async function processSellerDisclosureRequest(
  request: Request,
  env: ShopEnv,
  input: DisclosureRequestPayload,
): Promise<{ requestId: string }> {
  const runtime = getSellerAddressDisclosureRuntime(env, request)
  if (!runtime || !env.TURNSTILE_SECRET_KEY) throw disclosureUnavailable()

  const db = getDb(env)
  if (!(await hasSellerAddressDisclosureSchema(db)))
    throw disclosureUnavailable()

  const ip = getDisclosureClientIp(request)
  if (!ip) throw disclosureUnavailable()

  const now = new Date()
  await cleanupExpiredDisclosureData(db, now)
  await consumeScopedRateLimit(
    db,
    runtime.hmacSecret,
    'attempt-ip',
    ip,
    now,
    ATTEMPT_WINDOW_SECONDS,
    ATTEMPT_LIMIT,
  )

  const turnstileValid = await verifyDisclosureTurnstile(
    request,
    input.turnstileToken,
    env.TURNSTILE_SECRET_KEY,
    runtime.allowedHostnames,
  )
  if (!turnstileValid) {
    throw new ShopApiError(
      403,
      'セキュリティ確認を完了できませんでした。もう一度お試しください。',
    )
  }

  const [emailHash, ipHash] = await Promise.all([
    hmacHex(runtime.hmacSecret, `email\u0000${input.email}`),
    hmacHex(runtime.hmacSecret, `ip\u0000${ip}`),
  ])
  const claim = await claimDisclosureRequest(
    db,
    input.requestId,
    emailHash,
    ipHash,
    now,
  )
  if (claim === 'sent') return { requestId: input.requestId }

  try {
    await Promise.all([
      consumeScopedRateLimit(
        db,
        runtime.hmacSecret,
        'send-ip',
        ip,
        now,
        IP_SEND_WINDOW_SECONDS,
        IP_SEND_LIMIT,
      ),
      consumeScopedRateLimit(
        db,
        runtime.hmacSecret,
        'send-email',
        input.email,
        now,
        EMAIL_SEND_WINDOW_SECONDS,
        EMAIL_SEND_LIMIT,
      ),
      consumeScopedRateLimit(
        db,
        runtime.hmacSecret,
        'send-global',
        'all',
        now,
        GLOBAL_SEND_WINDOW_SECONDS,
        GLOBAL_SEND_LIMIT,
      ),
    ])
  } catch (error) {
    await releaseDisclosureClaim(db, input.requestId, emailHash)
    throw error
  }

  let messageId: string
  try {
    messageId = await sendSellerDisclosureEmail(runtime, input)
  } catch {
    await markDisclosureDeliveryUnknown(db, input.requestId, emailHash)
    throw deliveryStatusUnknown()
  }

  const persisted = await db
    .prepare(
      `UPDATE shop_disclosure_requests
       SET status = 'sent',
           processing_token = NULL,
           email_message_id = ?,
           failure_code = NULL,
           sent_at = ?,
           updated_at = ?
       WHERE id = ?
         AND email_hash = ?
         AND status = 'processing'`,
    )
    .bind(
      messageId,
      now.toISOString(),
      now.toISOString(),
      input.requestId,
      emailHash,
    )
    .run()

  if (persisted.meta?.changes !== 1) {
    await markDisclosureDeliveryUnknown(db, input.requestId, emailHash)
    throw deliveryStatusUnknown()
  }

  return { requestId: input.requestId }
}

async function verifyDisclosureTurnstile(
  request: Request,
  token: string,
  secret: string,
  allowedHostnames: string[],
): Promise<boolean> {
  const requestUrl = new URL(request.url)
  if (
    (requestUrl.hostname === 'localhost' ||
      requestUrl.hostname === '127.0.0.1') &&
    token === 'local-dev'
  ) {
    return true
  }

  const body = new URLSearchParams({ secret, response: token })
  const ip = getClientIp(request)
  if (ip) body.set('remoteip', ip)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    })
    if (!response.ok) return false

    const result = (await response.json()) as TurnstileResult
    return Boolean(
      result.success &&
      result.action === SELLER_DISCLOSURE_TURNSTILE_ACTION &&
      result.hostname &&
      allowedHostnames.includes(result.hostname.toLowerCase()),
    )
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function claimDisclosureRequest(
  db: D1Database,
  requestId: string,
  emailHash: string,
  ipHash: string,
  now: Date,
): Promise<'claimed' | 'sent'> {
  const existing = await db
    .prepare(
      `SELECT id, email_hash, status
       FROM shop_disclosure_requests
       WHERE id = ?`,
    )
    .bind(requestId)
    .first<DisclosureRequestRow>()

  if (existing) {
    if (existing.email_hash !== emailHash) {
      throw new ShopApiError(
        409,
        '送信内容を確認して、もう一度お試しください。',
      )
    }
    if (existing.status === 'sent') return 'sent'
    if (existing.status === 'delivery_unknown') throw deliveryStatusUnknown()
    if (existing.status === 'processing') {
      throw new ShopApiError(409, '開示請求を処理しています。')
    }
    throw disclosureUnavailable()
  }

  try {
    const inserted = await db
      .prepare(
        `INSERT INTO shop_disclosure_requests (
           id, email_hash, ip_hash, status, processing_token, expires_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'processing', ?, ?, ?, ?)`,
      )
      .bind(
        requestId,
        emailHash,
        ipHash,
        crypto.randomUUID(),
        receiptExpiresAt(now),
        now.toISOString(),
        now.toISOString(),
      )
      .run()
    if (inserted.meta?.changes === 1) return 'claimed'
  } catch {
    const unresolved = await db
      .prepare(
        `SELECT id, email_hash, status
         FROM shop_disclosure_requests
         WHERE email_hash = ?
           AND status IN ('processing', 'delivery_unknown')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .bind(emailHash)
      .first<DisclosureRequestRow>()
    if (unresolved?.status === 'delivery_unknown') throw deliveryStatusUnknown()
    if (unresolved?.status === 'processing') {
      throw new ShopApiError(409, '開示請求を処理しています。')
    }
  }

  throw disclosureUnavailable()
}

async function releaseDisclosureClaim(
  db: D1Database,
  requestId: string,
  emailHash: string,
) {
  await db
    .prepare(
      `DELETE FROM shop_disclosure_requests
       WHERE id = ?
         AND email_hash = ?
         AND status = 'processing'`,
    )
    .bind(requestId, emailHash)
    .run()
}

async function markDisclosureDeliveryUnknown(
  db: D1Database,
  requestId: string,
  emailHash: string,
) {
  try {
    await db
      .prepare(
        `UPDATE shop_disclosure_requests
         SET status = 'delivery_unknown',
             processing_token = NULL,
             failure_code = 'delivery_status_unknown',
             updated_at = ?
         WHERE id = ?
           AND email_hash = ?
           AND status = 'processing'`,
      )
      .bind(new Date().toISOString(), requestId, emailHash)
      .run()
  } catch {
    // The processing record remains non-retryable until retention cleanup.
  }
}

async function consumeScopedRateLimit(
  db: D1Database,
  secret: string,
  scope: string,
  value: string,
  now: Date,
  windowSeconds: number,
  limit: number,
) {
  const window = rateLimitWindow(now, windowSeconds)
  const bucketKey = await hmacHex(secret, `${scope}:${window.id}\u0000${value}`)
  const row = await db
    .prepare(
      `INSERT INTO shop_disclosure_rate_limits (
         bucket_key, request_count, expires_at, updated_at
       ) VALUES (?, 1, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         request_count = shop_disclosure_rate_limits.request_count + 1,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       RETURNING request_count`,
    )
    .bind(bucketKey, window.expiresAt, now.toISOString())
    .first<RateLimitRow>()

  if (!row) throw disclosureUnavailable()
  if (row.request_count > limit) {
    throw new ShopApiError(
      429,
      '送信回数が上限に達しました。時間をおいてお試しください。',
    )
  }
}

async function cleanupExpiredDisclosureData(db: D1Database, now: Date) {
  const nowIso = now.toISOString()
  await db.batch([
    db
      .prepare('DELETE FROM shop_disclosure_rate_limits WHERE expires_at <= ?')
      .bind(nowIso),
    db
      .prepare('DELETE FROM shop_disclosure_requests WHERE expires_at <= ?')
      .bind(nowIso),
  ])
}

async function sendSellerDisclosureEmail(
  runtime: SellerAddressDisclosureRuntime,
  input: DisclosureRequestPayload,
) {
  const response = await runtime.emailService.fetch(
    createSellerAddressDisclosureServiceRequest(runtime, '/v1/disclosures', {
      requestId: input.requestId,
      recipientEmail: input.email,
      ...runtime.publicProfile,
    }),
  )
  if (!response.ok) throw disclosureUnavailable()

  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown
    messageId?: unknown
  } | null
  const messageId = String(payload?.messageId || '').trim()
  if (!payload?.ok || !messageId || messageId.length > 500) {
    throw disclosureUnavailable()
  }

  return messageId
}

async function hmacHex(secret: string, value: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function rateLimitWindow(now: Date, windowSeconds: number) {
  const milliseconds = windowSeconds * 1_000
  const id = Math.floor(now.getTime() / milliseconds)
  return {
    id,
    expiresAt: new Date((id + 1) * milliseconds).toISOString(),
  }
}

function receiptExpiresAt(now: Date) {
  return new Date(now.getTime() + RETENTION_DAYS * 86_400_000).toISOString()
}

function getDisclosureClientIp(request: Request) {
  const ip = getClientIp(request)
  if (ip) return ip

  const hostname = new URL(request.url).hostname
  return hostname === 'localhost' || hostname === '127.0.0.1'
    ? '127.0.0.1'
    : null
}

function invalidRequest() {
  return new ShopApiError(422, 'メールアドレスと同意内容を確認してください。')
}

function disclosureUnavailable() {
  return new ShopApiError(
    503,
    '現在、販売者情報の開示請求を受け付けられません。時間をおいてお試しください。',
  )
}

function deliveryStatusUnknown() {
  return new ShopApiError(
    409,
    '送信結果を確認できないため、重複送信を避けて再送を停止しました。問い合わせ窓口へご連絡ください。',
  )
}
