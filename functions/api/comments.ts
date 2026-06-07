type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>
  run(): Promise<unknown>
}

type D1Database = {
  prepare(query: string): D1PreparedStatement
}

type Env = {
  COMMENTS_DB?: D1Database
  TURNSTILE_SECRET_KEY?: string
  COMMENT_HASH_SALT?: string
  COMMENT_ALLOWED_HOSTNAMES?: string
}

type PagesContext = {
  request: Request
  env: Env
}

type CommentPayload = {
  slug?: unknown
  authorName?: unknown
  body?: unknown
  turnstileToken?: unknown
  website?: unknown
}

type CommentRow = {
  id: string
  post_slug: string
  locale: string
  author_name: string
  body: string
  created_at: string
}

type ApiMessageKey =
  | 'unavailable'
  | 'invalid'
  | 'rateLimited'
  | 'turnstile'
  | 'failed'

const API_MESSAGES: Record<ApiMessageKey, string> = {
  unavailable: 'コメント機能を一時的に利用できません。',
  invalid: 'コメントを投稿できませんでした。内容を確認してください。',
  rateLimited:
    '短時間に投稿できる回数を超えました。少し待ってからお試しください。',
  turnstile: '送信前の確認に失敗しました。もう一度お試しください。',
  failed: 'コメントを投稿できませんでした。',
}

const SITEVERIFY_ENDPOINT =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const MAX_AUTHOR_LENGTH = 24
const MAX_BODY_LENGTH = 600
const MIN_BODY_MEANINGFUL_LENGTH = 8
const MAX_GET_LIMIT = 100
const POST_RATE_WINDOW_MS = 15 * 60 * 1000
const POST_RATE_MAX_REQUESTS = 3
const READ_RATE_WINDOW_MS = 60 * 1000
const READ_RATE_MAX_REQUESTS = 60
const RATE_LIMIT_MAX_BUCKETS = 3000
const PERSISTENT_CLIENT_WINDOW_MS = 15 * 60 * 1000
const PERSISTENT_POST_WINDOW_MS = 30 * 60 * 1000
const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_ALLOWED_HOSTNAMES = [
  'hatt.acecore.net',
  'www.hatt.acecore.net',
  'homepage-hatt.pages.dev',
  'localhost',
  '127.0.0.1',
]

const URL_PATTERN =
  /\b(?:https?:\/\/|www\.|[a-z0-9][a-z0-9.-]*\.(?:com|net|org|info|biz|xyz|top|site|online|shop|click|link|ru|cn|jp)\b)/i
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i
const HTML_TAG_PATTERN = /<[^>]{2,}>/
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\([^)]+\)/
const REPEATED_CHARACTER_PATTERN = /(.)\1{12,}/u
const SPAM_WORD_PATTERN =
  /(casino|viagra|porn|payday|loan|forex|crypto|bitcoin|gambling|slot|カジノ|アダルト|出会い系|副業|稼げ|借金|投資|仮想通貨|ビットコイン|無料登録)/i

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

export const onRequestGet = async ({
  request,
  env,
}: PagesContext): Promise<Response> => {
  if (!isAllowedRequestOrigin(request, env)) {
    return jsonResponse(
      { ok: false, message: message('invalid'), comments: [] },
      403,
    )
  }

  if (!env.COMMENTS_DB) {
    return jsonResponse(
      { ok: false, message: message('unavailable'), comments: [] },
      503,
    )
  }

  const readLimit = checkMemoryRateLimit(
    `read:${getClientFingerprint(request)}`,
    READ_RATE_MAX_REQUESTS,
    READ_RATE_WINDOW_MS,
  )

  if (!readLimit.allowed) {
    return jsonResponse(
      { ok: false, message: message('rateLimited'), comments: [] },
      429,
      { 'Retry-After': String(readLimit.retryAfterSeconds || 60) },
    )
  }

  const url = new URL(request.url)
  const slug = normalizeSlug(url.searchParams.get('slug'))
  const limit = normalizeLimit(url.searchParams.get('limit'))

  if (!slug) {
    return jsonResponse(
      { ok: false, message: message('invalid'), comments: [] },
      400,
    )
  }

  try {
    const rows = await env.COMMENTS_DB.prepare(
      `SELECT id, post_slug, locale, author_name, body, created_at
       FROM blog_comments
       WHERE post_slug = ? AND deleted_at IS NULL
       ORDER BY created_at ASC
       LIMIT ?`,
    )
      .bind(slug, limit)
      .all<CommentRow>()

    return jsonResponse({
      ok: true,
      comments: (rows.results ?? []).map(toPublicComment),
    })
  } catch (error) {
    console.error('Failed to load comments:', error)
    return jsonResponse(
      { ok: false, message: message('unavailable'), comments: [] },
      503,
    )
  }
}

export const onRequestPost = async ({
  request,
  env,
}: PagesContext): Promise<Response> => {
  if (!isAllowedRequestOrigin(request, env)) {
    return jsonResponse({ ok: false, message: message('invalid') }, 403)
  }

  const payload = (await request
    .json()
    .catch(() => null)) as CommentPayload | null
  const validation = validatePayload(payload)

  if (!env.COMMENTS_DB) {
    return jsonResponse({ ok: false, message: message('unavailable') }, 503)
  }

  if (!validation.ok) {
    return jsonResponse(
      { ok: false, message: message(validation.messageKey) },
      400,
    )
  }

  if (
    (!env.TURNSTILE_SECRET_KEY || !env.COMMENT_HASH_SALT) &&
    !isLocalRequestHost(request)
  ) {
    return jsonResponse({ ok: false, message: message('unavailable') }, 503)
  }

  const memoryLimit = checkMemoryRateLimit(
    `post:${getClientFingerprint(request)}`,
    POST_RATE_MAX_REQUESTS,
    POST_RATE_WINDOW_MS,
  )

  if (!memoryLimit.allowed) {
    return jsonResponse({ ok: false, message: message('rateLimited') }, 429, {
      'Retry-After': String(memoryLimit.retryAfterSeconds || 60),
    })
  }

  const turnstileValid = await verifyTurnstile(
    request,
    env,
    validation.turnstileToken,
  )

  if (!turnstileValid) {
    return jsonResponse({ ok: false, message: message('turnstile') }, 403)
  }

  const now = new Date()
  const salt = env.COMMENT_HASH_SALT || 'hatt-comments-local'
  const userAgent = request.headers.get('User-Agent') || ''
  const clientIp = getClientIp(request)
  const clientHash = await sha256Hex(
    `${salt}:client:${clientIp || 'unknown'}:${userAgent.slice(0, 96)}`,
  )
  const userAgentHash = await sha256Hex(`${salt}:ua:${userAgent}`)
  const bodyHash = await sha256Hex(normalizeForDuplicate(validation.body))

  try {
    const persistentLimit = await checkPersistentRateLimit(
      env.COMMENTS_DB,
      clientHash,
      validation.slug,
      now,
    )

    if (!persistentLimit.allowed) {
      return jsonResponse({ ok: false, message: message('rateLimited') }, 429, {
        'Retry-After': String(persistentLimit.retryAfterSeconds || 60),
      })
    }

    const duplicate = await env.COMMENTS_DB.prepare(
      `SELECT id
       FROM blog_comments
       WHERE post_slug = ? AND body_hash = ? AND created_at >= ? AND deleted_at IS NULL
       LIMIT 1`,
    )
      .bind(
        validation.slug,
        bodyHash,
        new Date(now.getTime() - DUPLICATE_WINDOW_MS).toISOString(),
      )
      .first<{ id: string }>()

    if (duplicate) {
      return jsonResponse({ ok: false, message: message('invalid') }, 400)
    }

    const row = {
      id: crypto.randomUUID(),
      post_slug: validation.slug,
      locale: 'ja',
      author_name: validation.authorName,
      body: validation.body,
      body_hash: bodyHash,
      client_hash: clientHash,
      user_agent_hash: userAgentHash,
      risk_score: 0,
      created_at: now.toISOString(),
    }

    await env.COMMENTS_DB.prepare(
      `INSERT INTO blog_comments (
         id, post_slug, locale, author_name, body, body_hash,
         client_hash, user_agent_hash, risk_score, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.post_slug,
        row.locale,
        row.author_name,
        row.body,
        row.body_hash,
        row.client_hash,
        row.user_agent_hash,
        row.risk_score,
        row.created_at,
      )
      .run()

    return jsonResponse({ ok: true, comment: toPublicComment(row) }, 201)
  } catch (error) {
    console.error('Failed to post comment:', error)
    return jsonResponse({ ok: false, message: message('failed') }, 500)
  }
}

export const onRequestOptions = ({ request, env }: PagesContext): Response =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': getCorsOrigin(request, env),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
    },
  })

function validatePayload(payload: CommentPayload | null):
  | {
      ok: true
      slug: string
      authorName: string
      body: string
      turnstileToken: string
    }
  | { ok: false; messageKey: ApiMessageKey } {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, messageKey: 'invalid' }
  }

  if (String(payload.website || '').trim()) {
    return { ok: false, messageKey: 'invalid' }
  }

  const slug = normalizeSlug(payload.slug)
  const authorName = normalizeAuthorName(payload.authorName)
  const body = normalizeBody(payload.body)
  const turnstileToken = String(payload.turnstileToken || '').trim()

  if (!slug || !authorName || !body || !turnstileToken) {
    return { ok: false, messageKey: 'invalid' }
  }

  if (
    authorName.length > MAX_AUTHOR_LENGTH ||
    body.length > MAX_BODY_LENGTH ||
    turnstileToken.length > 2048
  ) {
    return { ok: false, messageKey: 'invalid' }
  }

  if (countMeaningfulCharacters(body) < MIN_BODY_MEANINGFUL_LENGTH) {
    return { ok: false, messageKey: 'invalid' }
  }

  if (isBlockedText(`${authorName}\n${body}`)) {
    return { ok: false, messageKey: 'invalid' }
  }

  return { ok: true, slug, authorName, body, turnstileToken }
}

function normalizeSlug(value: unknown): string | null {
  const slug = String(value || '')
    .trim()
    .toLowerCase()

  return /^[a-z0-9][a-z0-9_-]{0,120}$/.test(slug) ? slug : null
}

function normalizeLimit(value: unknown): number {
  const limit = Number(value || 50)
  return Number.isFinite(limit)
    ? Math.min(Math.max(Math.floor(limit), 1), MAX_GET_LIMIT)
    : 50
}

function normalizeAuthorName(value: unknown): string {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeBody(value: unknown): string {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeForDuplicate(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function countMeaningfulCharacters(value: string): number {
  return Array.from(value.replace(/[^\p{L}\p{N}]/gu, '')).length
}

function isBlockedText(value: string): boolean {
  return (
    URL_PATTERN.test(value) ||
    EMAIL_PATTERN.test(value) ||
    HTML_TAG_PATTERN.test(value) ||
    MARKDOWN_LINK_PATTERN.test(value) ||
    REPEATED_CHARACTER_PATTERN.test(value) ||
    SPAM_WORD_PATTERN.test(value)
  )
}

async function verifyTurnstile(
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

  try {
    const response = await fetch(SITEVERIFY_ENDPOINT, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) return false

    const result = (await response.json()) as {
      success?: boolean
      hostname?: string
    }
    return Boolean(
      result.success &&
      (!result.hostname || isAllowedVerifiedHostname(result.hostname, env)),
    )
  } catch (error) {
    console.error('Turnstile validation failed:', error)
    return false
  }
}

async function checkPersistentRateLimit(
  db: D1Database,
  clientHash: string,
  postSlug: string,
  now: Date,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const clientRecent = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM blog_comments
       WHERE client_hash = ? AND created_at >= ? AND deleted_at IS NULL`,
    )
    .bind(
      clientHash,
      new Date(now.getTime() - PERSISTENT_CLIENT_WINDOW_MS).toISOString(),
    )
    .first<{ count: number }>()

  if (Number(clientRecent?.count || 0) >= POST_RATE_MAX_REQUESTS) {
    return { allowed: false, retryAfterSeconds: 15 * 60 }
  }

  const postRecent = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM blog_comments
       WHERE client_hash = ? AND post_slug = ? AND created_at >= ? AND deleted_at IS NULL`,
    )
    .bind(
      clientHash,
      postSlug,
      new Date(now.getTime() - PERSISTENT_POST_WINDOW_MS).toISOString(),
    )
    .first<{ count: number }>()

  if (Number(postRecent?.count || 0) >= 2) {
    return { allowed: false, retryAfterSeconds: 30 * 60 }
  }

  return { allowed: true }
}

function checkMemoryRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now()

  if (rateLimitBuckets.size > RATE_LIMIT_MAX_BUCKETS) {
    for (const [bucketKey, bucket] of rateLimitBuckets) {
      if (bucket.resetAt <= now) rateLimitBuckets.delete(bucketKey)
    }
  }

  const bucket = rateLimitBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true }
  }

  bucket.count += 1

  if (bucket.count > maxRequests) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
    }
  }

  return { allowed: true }
}

function isAllowedRequestOrigin(request: Request, env: Env): boolean {
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

function getCorsOrigin(request: Request, env: Env): string {
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

function isLocalRequestHost(request: Request): boolean {
  const hostname = new URL(request.url).hostname
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function getClientIp(request: Request): string | null {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    null
  )
}

function getClientFingerprint(request: Request): string {
  return `${getClientIp(request) || 'unknown'}:${request.headers
    .get('User-Agent')
    ?.slice(0, 96)}`
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function toPublicComment(row: CommentRow) {
  return {
    id: row.id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
  }
}

function message(key: ApiMessageKey) {
  return API_MESSAGES[key]
}

function jsonResponse(
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
