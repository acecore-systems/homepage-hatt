export type Env = {
  TURNSTILE_SECRET_KEY?: string
  COMMENT_ALLOWED_HOSTNAMES?: string
  COURSE_SIGNUP_EMAIL_TO?: string
  COURSE_SIGNUP_EMAIL_FROM?: string
  COURSE_SIGNUP_EMAIL?: SendEmailBinding
}

export type PagesContext = {
  request: Request
  env: Env
  waitUntil(promise: Promise<unknown>): void
}

export type CourseSignup = {
  id: string
  name: string
  contact: string
  goal: string
  preferredTime: string
  createdAt: string
}

type TurnstileResponse = {
  success?: boolean
  hostname?: string
}

type SendEmailBinding = {
  send(message: EmailMessageBuilder): Promise<EmailSendResult>
}

type EmailAddress = string | { email: string; name?: string }

type EmailMessageBuilder = {
  to: EmailAddress | EmailAddress[]
  from: EmailAddress
  subject: string
  text: string
  replyTo?: EmailAddress
}

type EmailSendResult = {
  messageId: string
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

export function optionsResponse(request: Request, env: Env): Response {
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

export async function sendCourseSignupEmail(
  request: Request,
  env: Env,
  signup: CourseSignup,
): Promise<string> {
  const from = parseEmailAddress(env.COURSE_SIGNUP_EMAIL_FROM)
  const to = parseEmailAddresses(env.COURSE_SIGNUP_EMAIL_TO)

  if (!env.COURSE_SIGNUP_EMAIL || !from || to.length === 0) {
    throw new Error('Course signup email is not configured')
  }

  const message: EmailMessageBuilder = {
    from,
    to,
    subject: `【Hatt講座】無料体験申し込み: ${signup.name}`,
    text: buildCourseSignupEmailText(request, signup),
  }
  const replyTo = extractReplyTo(signup.contact)
  if (replyTo) message.replyTo = replyTo

  const result = await env.COURSE_SIGNUP_EMAIL.send(message)

  return result.messageId || ''
}

export function toPublicSignup(signup: CourseSignup) {
  return {
    id: signup.id,
    name: signup.name,
    contact: signup.contact,
    goal: signup.goal,
    preferredTime: signup.preferredTime,
    createdAt: signup.createdAt,
  }
}

function buildCourseSignupEmailText(
  request: Request,
  signup: CourseSignup,
): string {
  const requestUrl = new URL(request.url)
  const clientIp = getClientIp(request) || 'unknown'

  return [
    'モデル制作講座の無料体験申し込みが届きました。',
    '',
    `名前: ${signup.name}`,
    `連絡先: ${signup.contact}`,
    `希望日時: ${signup.preferredTime}`,
    '',
    '作りたいもの・相談したいこと:',
    signup.goal,
    '',
    `受付日時: ${signup.createdAt}`,
    `送信元ページ: ${requestUrl.origin}/modeling-course/`,
    `送信元IP: ${clientIp}`,
  ].join('\n')
}

function parseEmailAddresses(value: string | undefined): EmailAddress[] {
  return String(value || '')
    .split(',')
    .map((email) => parseEmailAddress(email))
    .filter((email): email is EmailAddress => Boolean(email))
}

function parseEmailAddress(value: string | undefined): EmailAddress | null {
  const normalized = String(value || '').trim()
  if (!normalized) return null

  const match = normalized.match(/^(.+?)\s*<([^<>]+)>$/)
  if (!match) return normalized

  const name = match[1].trim().replace(/^["']|["']$/g, '')
  const email = match[2].trim()

  return name ? { email, name } : email
}

function extractReplyTo(contact: string): string | undefined {
  const match = contact.match(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i)
  return match?.[0]
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
