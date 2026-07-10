import { createRemoteJWKSet, jwtVerify } from 'jose'

export type CmsAccessEnv = {
  CMS_ACCESS_ALLOWED_EMAILS?: string
  CMS_ACCESS_ALLOWED_DOMAINS?: string
  CMS_ACCESS_HOSTNAMES?: string
  CMS_ACCESS_TEAM_DOMAIN?: string
  CMS_ACCESS_AUD?: string
  CMS_GITHUB_TOKEN?: string
}

type AccessIdentity =
  | { ok: true; email: string }
  | { ok: false; status: number; message: string }

const DEFAULT_ACCESS_HOSTNAMES = [
  'hatt.acecore.net',
  'www.hatt.acecore.net',
  'homepage-hatt.pages.dev',
  '*.homepage-hatt.pages.dev',
  'localhost',
  '127.0.0.1',
]

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function getAccessIdentity(
  request: Request,
  env: CmsAccessEnv,
): Promise<AccessIdentity> {
  const hostname = new URL(request.url).hostname.toLowerCase()

  if (!isAllowedAccessHostname(hostname, env)) {
    return {
      ok: false,
      status: 401,
      message:
        'Cloudflare Accessで保護されたCMSドメインからログインしてください。',
    }
  }

  const issuer = normalizeAccessIssuer(env.CMS_ACCESS_TEAM_DOMAIN)
  const audience = env.CMS_ACCESS_AUD?.trim()

  if (!issuer || !audience) {
    return {
      ok: false,
      status: 503,
      message: 'Cloudflare Access JWT検証設定がCloudflare Pagesにありません。',
    }
  }

  const token = request.headers.get('cf-access-jwt-assertion') || ''

  if (!token) {
    return {
      ok: false,
      status: 401,
      message: 'Cloudflare Accessでログインしてください。',
    }
  }

  let email = ''

  try {
    const { payload } = await jwtVerify(token, getRemoteJwkSet(issuer), {
      algorithms: ['RS256'],
      audience,
      clockTolerance: 60,
      issuer,
    })

    email = typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
  } catch {
    return {
      ok: false,
      status: 401,
      message: 'Cloudflare Accessの認証を確認できません。',
    }
  }

  if (!email) {
    return {
      ok: false,
      status: 403,
      message: 'Cloudflare Accessのメールを確認できません。',
    }
  }

  if (!isAllowedAccessEmail(email, env)) {
    return {
      ok: false,
      status: 403,
      message: 'CMS編集が許可されていないCloudflare Accessユーザーです。',
    }
  }

  return { ok: true, email }
}

function getRemoteJwkSet(issuer: string) {
  let jwks = jwksByIssuer.get(issuer)

  if (!jwks) {
    jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', `${issuer}/`))
    jwksByIssuer.set(issuer, jwks)
  }

  return jwks
}

function normalizeAccessIssuer(value: string | undefined) {
  if (!value) return null

  try {
    const url = new URL(value)

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '') ||
      !url.hostname.endsWith('.cloudflareaccess.com')
    ) {
      return null
    }

    return url.origin
  } catch {
    return null
  }
}

function isAllowedAccessHostname(hostname: string, env: CmsAccessEnv) {
  return [...DEFAULT_ACCESS_HOSTNAMES, ...parseCsv(env.CMS_ACCESS_HOSTNAMES)]
    .filter(Boolean)
    .some((pattern) => hostnameMatches(pattern, hostname))
}

function isAllowedAccessEmail(email: string, env: CmsAccessEnv) {
  const allowed = parseCsv(env.CMS_ACCESS_ALLOWED_EMAILS)
  const allowedDomains = parseCsv(env.CMS_ACCESS_ALLOWED_DOMAINS)
  const normalizedEmail = email.toLowerCase()
  const domain = normalizedEmail.split('@').pop() || ''

  return allowed.includes(normalizedEmail) || allowedDomains.includes(domain)
}

function parseCsv(value: string | undefined) {
  return (value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function hostnameMatches(pattern: string, hostname: string) {
  const normalizedPattern = pattern.trim().toLowerCase()

  if (normalizedPattern.startsWith('*.')) {
    return hostname.endsWith(normalizedPattern.slice(1))
  }

  return hostname === normalizedPattern
}
