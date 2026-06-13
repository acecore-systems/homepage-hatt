type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>
  run(): Promise<unknown>
}

export type D1Database = {
  prepare(query: string): D1PreparedStatement
}

export type Env = {
  COMMENTS_DB?: D1Database
  TURNSTILE_SECRET_KEY?: string
  COMMENT_HASH_SALT?: string
  COMMENT_ALLOWED_HOSTNAMES?: string
  COURSE_ADMIN_PASSCODE?: string
  COURSE_VAPID_PUBLIC_KEY?: string
  COURSE_VAPID_PRIVATE_KEY?: string
  COURSE_VAPID_SUBJECT?: string
}

export type PagesContext = {
  request: Request
  env: Env
  waitUntil(promise: Promise<unknown>): void
}

export type CourseSignupRow = {
  id: string
  name: string
  contact: string
  goal: string
  preferred_time: string
  status: string
  created_at: string
  updated_at: string
}

type TurnstileResponse = {
  success?: boolean
  hostname?: string
}

type PushSubscriptionRow = {
  endpoint: string
  subscription_json: string
}

const SITEVERIFY_ENDPOINT =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const DEFAULT_ALLOWED_HOSTNAMES = [
  'hatt.acecore.net',
  'www.hatt.acecore.net',
  'homepage-hatt.pages.dev',
  'localhost',
  '127.0.0.1',
]
const WEB_PUSH_TTL_SECONDS = 10 * 60
const ADMIN_PASSCODE_HEADER = 'X-Course-Admin-Passcode'

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

export function optionsResponse(request: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': getCorsOrigin(request, env),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': `Accept, Content-Type, Authorization, ${ADMIN_PASSCODE_HEADER}`,
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  })
}

export async function readJsonPayload<T>(request: Request): Promise<T | null> {
  return request.json().catch(() => null) as Promise<T | null>
}

export function normalizeText(
  value: unknown,
  maxLength: number,
  multiline = false,
): string {
  const normalized = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join(multiline ? '\n' : ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return normalized.length <= maxLength ? normalized : ''
}

export function countMeaningfulCharacters(value: string): number {
  return Array.from(value.replace(/[^\p{L}\p{N}]/gu, '')).length
}

export async function verifyTurnstile(
  request: Request,
  env: Env,
  token: string,
): Promise<boolean> {
  if (isLocalRequestHost(request) && token === 'local-dev') return true
  if (!env.TURNSTILE_SECRET_KEY) return false

  const formData = new FormData()
  formData.append('secret', env.TURNSTILE_SECRET_KEY)
  formData.append('response', token)

  const remoteIp = getClientIp(request)
  if (remoteIp) formData.append('remoteip', remoteIp)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(SITEVERIFY_ENDPOINT, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    })

    if (!response.ok) return false

    const result = (await response.json()) as TurnstileResponse
    return Boolean(
      result.success &&
      (!result.hostname || isAllowedVerifiedHostname(result.hostname, env)),
    )
  } catch (error) {
    console.error('Course Turnstile validation failed:', error)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export function isAllowedRequestOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) return true

  try {
    const originUrl = new URL(origin)
    const requestUrl = new URL(request.url)

    if (originUrl.hostname === requestUrl.hostname) return true
    return isAllowedVerifiedHostname(originUrl.hostname, env)
  } catch {
    return false
  }
}

export function getCorsOrigin(request: Request, env: Env): string {
  const origin = request.headers.get('Origin')
  if (!origin) return 'https://hatt.acecore.net'

  try {
    const hostname = new URL(origin).hostname
    if (
      isAllowedRequestOrigin(request, env) ||
      isAllowedVerifiedHostname(hostname, env)
    ) {
      return origin
    }
  } catch {
    // Fall through to the production origin.
  }

  return 'https://hatt.acecore.net'
}

export function isLocalRequestHost(request: Request): boolean {
  const hostname = new URL(request.url).hostname
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

export function getClientIp(request: Request): string | null {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    null
  )
}

export async function getClientHashes(
  request: Request,
  env: Env,
): Promise<{ clientHash: string; userAgentHash: string }> {
  const salt = env.COMMENT_HASH_SALT || 'hatt-course-local'
  const userAgent = request.headers.get('User-Agent') || ''
  const clientIp = getClientIp(request)

  const [clientHash, userAgentHash] = await Promise.all([
    sha256Hex(`${salt}:course-client:${clientIp || 'unknown'}:${userAgent}`),
    sha256Hex(`${salt}:course-ua:${userAgent}`),
  ])

  return { clientHash, userAgentHash }
}

export async function verifyAdminRequest(
  request: Request,
  env: Env,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const expectedPasscode =
    env.COURSE_ADMIN_PASSCODE?.trim() ||
    (isLocalRequestHost(request) ? 'local-dev' : '')

  if (!expectedPasscode) {
    return {
      ok: false,
      response: jsonResponse(
        { ok: false, message: '管理用パスコードが設定されていません。' },
        503,
      ),
    }
  }

  const actualPasscode = getAdminPasscode(request)
  if (!actualPasscode) {
    return {
      ok: false,
      response: jsonResponse(
        { ok: false, message: '管理用パスコードを入力してください。' },
        401,
      ),
    }
  }

  const valid = await timingSafeEqual(actualPasscode, expectedPasscode)
  if (!valid) {
    return {
      ok: false,
      response: jsonResponse(
        { ok: false, message: '管理用パスコードが正しくありません。' },
        403,
      ),
    }
  }

  return { ok: true }
}

export function toPublicSignup(row: CourseSignupRow) {
  return {
    id: row.id,
    name: row.name,
    contact: row.contact,
    goal: row.goal,
    preferredTime: row.preferred_time,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function notifyCourseAdmins(
  env: Env,
  signupId: string,
): Promise<void> {
  if (
    !env.COMMENTS_DB ||
    !env.COURSE_VAPID_PUBLIC_KEY ||
    !env.COURSE_VAPID_PRIVATE_KEY
  ) {
    return
  }

  try {
    const rows = await env.COMMENTS_DB.prepare(
      `SELECT endpoint, subscription_json
       FROM course_push_subscriptions
       WHERE disabled_at IS NULL`,
    ).all<PushSubscriptionRow>()

    await Promise.all(
      (rows.results ?? []).map((row) =>
        notifySubscription(env, row, signupId).catch((error) => {
          console.error('Course push notification failed:', error)
        }),
      ),
    )
  } catch (error) {
    console.error('Course notification lookup failed:', error)
  }
}

export async function sendTestCourseNotification(env: Env): Promise<number> {
  if (
    !env.COMMENTS_DB ||
    !env.COURSE_VAPID_PUBLIC_KEY ||
    !env.COURSE_VAPID_PRIVATE_KEY
  ) {
    throw new Error('Push notification environment is not configured')
  }

  const rows = await env.COMMENTS_DB.prepare(
    `SELECT endpoint, subscription_json
     FROM course_push_subscriptions
     WHERE disabled_at IS NULL`,
  ).all<PushSubscriptionRow>()

  let sent = 0

  for (const row of rows.results ?? []) {
    const response = await sendWebPush(env, row.endpoint)
    await recordPushResult(env.COMMENTS_DB, row.endpoint, response)
    if (response.ok) sent += 1
  }

  return sent
}

async function notifySubscription(
  env: Env,
  row: PushSubscriptionRow,
  signupId: string,
): Promise<void> {
  if (!env.COMMENTS_DB) return

  const response = await sendWebPush(env, row.endpoint)
  await recordPushResult(env.COMMENTS_DB, row.endpoint, response, signupId)
}

async function recordPushResult(
  db: D1Database,
  endpoint: string,
  response: Response,
  signupId = '',
): Promise<void> {
  const now = new Date().toISOString()

  if (response.ok) {
    await db
      .prepare(
        `UPDATE course_push_subscriptions
         SET last_seen_at = ?, last_error = NULL
         WHERE endpoint = ?`,
      )
      .bind(now, endpoint)
      .run()
    return
  }

  const errorText = `HTTP ${response.status}${signupId ? ` signup ${signupId}` : ''}`

  if (response.status === 404 || response.status === 410) {
    await db
      .prepare(
        `UPDATE course_push_subscriptions
         SET disabled_at = ?, last_error = ?
         WHERE endpoint = ?`,
      )
      .bind(now, errorText, endpoint)
      .run()
    return
  }

  await db
    .prepare(
      `UPDATE course_push_subscriptions
       SET last_error = ?
       WHERE endpoint = ?`,
    )
    .bind(errorText, endpoint)
    .run()
}

async function sendWebPush(env: Env, endpoint: string): Promise<Response> {
  const authorization = await createVapidAuthorizationHeader(env, endpoint)

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      TTL: String(WEB_PUSH_TTL_SECONDS),
      Urgency: 'high',
    },
  })
}

async function createVapidAuthorizationHeader(
  env: Env,
  endpoint: string,
): Promise<string> {
  const publicKey = env.COURSE_VAPID_PUBLIC_KEY?.trim()
  const privateKey = env.COURSE_VAPID_PRIVATE_KEY?.trim()

  if (!publicKey || !privateKey) {
    throw new Error('Missing VAPID keys')
  }

  const endpointOrigin = new URL(endpoint).origin
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60
  const subject =
    env.COURSE_VAPID_SUBJECT?.trim() || 'https://hatt.acecore.net/'
  const jwtHeader = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
  )
  const jwtPayload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ aud: endpointOrigin, exp, sub: subject }),
    ),
  )
  const signingInput = `${jwtHeader}.${jwtPayload}`
  const key = await importVapidPrivateKey(publicKey, privateKey)
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  )
  const token = `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`

  return `vapid t=${token}, k=${publicKey}`
}

async function importVapidPrivateKey(
  publicKey: string,
  privateKey: string,
): Promise<CryptoKey> {
  const publicKeyBytes = base64UrlToBytes(publicKey)

  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 4) {
    throw new Error('Invalid VAPID public key')
  }

  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    ext: true,
    d: privateKey,
    x: bytesToBase64Url(publicKeyBytes.slice(1, 33)),
    y: bytesToBase64Url(publicKeyBytes.slice(33, 65)),
  }

  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

function getAdminPasscode(request: Request): string {
  const auth = request.headers.get('Authorization') || ''
  const bearerMatch = auth.match(/^Bearer\s+(.+)$/i)
  if (bearerMatch) return bearerMatch[1].trim()

  return request.headers.get(ADMIN_PASSCODE_HEADER)?.trim() || ''
}

function isAllowedVerifiedHostname(hostname: string, env: Env): boolean {
  const normalized = hostname.toLowerCase()
  return getAllowedHostnames(env).some((allowedHostname) =>
    matchesAllowedHostname(normalized, allowedHostname),
  )
}

function matchesAllowedHostname(hostname: string, allowedHostname: string) {
  if (hostname === allowedHostname) return true
  if (allowedHostname === 'localhost' || allowedHostname === '127.0.0.1') {
    return false
  }
  return hostname.endsWith(`.${allowedHostname}`)
}

function getAllowedHostnames(env: Env): string[] {
  const configured = String(env.COMMENT_ALLOWED_HOSTNAMES || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)

  return configured.length > 0 ? configured : DEFAULT_ALLOWED_HOSTNAMES
}

async function timingSafeEqual(actual: string, expected: string) {
  const [actualHash, expectedHash] = await Promise.all([
    sha256Bytes(actual),
    sha256Bytes(expected),
  ])
  let diff = 0

  for (let index = 0; index < actualHash.length; index += 1) {
    diff |= actualHash[index] ^ expectedHash[index]
  }

  return diff === 0
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await sha256Bytes(value)

  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )

  return new Uint8Array(digest)
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
