export type Fetcher = {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>
}

export type FormEnv = {
  TURNSTILE_SECRET_KEY?: string
  COMMENT_ALLOWED_HOSTNAMES?: string
  SITE_EMAIL_SERVICE?: Fetcher
  COURSE_EMAIL_SERVICE?: Fetcher
}

export type EmailAddress = string | { email: string; name?: string }

export type EmailMessage = {
  to: EmailAddress | EmailAddress[]
  from: EmailAddress
  subject: string
  text: string
  replyTo?: string
}

type TurnstileResponse = {
  success?: boolean
  hostname?: string
}

type EmailServiceResponse = {
  ok?: boolean
  messageId?: string
  message?: string
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

export function optionsResponse(request: Request, env: FormEnv): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': getCorsOrigin(request, env),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
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
  env: FormEnv,
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
    console.error('Turnstile validation failed:', error)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export function isAllowedRequestOrigin(
  request: Request,
  env: FormEnv,
): boolean {
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

export async function sendTransactionalEmail(
  env: FormEnv,
  message: EmailMessage,
): Promise<string> {
  const emailService = env.SITE_EMAIL_SERVICE || env.COURSE_EMAIL_SERVICE
  if (!emailService) throw new Error('Email service is not configured')

  const endpoint = env.SITE_EMAIL_SERVICE
    ? 'https://site-email/send'
    : 'https://course-email/send'
  const response = await emailService.fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  })
  const result = (await response
    .json()
    .catch(() => ({}))) as EmailServiceResponse

  if (!response.ok || !result.ok) {
    const messageText =
      result.message || `Email service failed with HTTP ${response.status}`
    throw new Error(messageText)
  }

  return result.messageId || ''
}

export function parseEmailAddresses(value: string | undefined): EmailAddress[] {
  return String(value || '')
    .split(',')
    .map((email) => parseEmailAddress(email))
    .filter((email): email is EmailAddress => Boolean(email))
}

export function parseEmailAddress(
  value: string | undefined,
): EmailAddress | null {
  const normalized = String(value || '').trim()
  if (!normalized) return null

  const match = normalized.match(/^(.+?)\s*<([^<>]+)>$/)
  if (!match) return normalized

  const name = match[1].trim().replace(/^["']|["']$/g, '')
  const email = match[2].trim()

  return name ? { email, name } : email
}

export function getClientIp(request: Request): string | null {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    null
  )
}

function getCorsOrigin(request: Request, env: FormEnv): string {
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

function isLocalRequestHost(request: Request): boolean {
  const hostname = new URL(request.url).hostname
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function isAllowedVerifiedHostname(hostname: string, env: FormEnv): boolean {
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

function getAllowedHostnames(env: FormEnv): string[] {
  const configured = String(env.COMMENT_ALLOWED_HOSTNAMES || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)

  return configured.length > 0 ? configured : DEFAULT_ALLOWED_HOSTNAMES
}
