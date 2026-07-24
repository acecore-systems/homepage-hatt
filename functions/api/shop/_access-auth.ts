import { createRemoteJWKSet, jwtVerify } from 'jose'

export type ShopAccessEnv = {
  SHOP_ACCESS_HOSTNAMES?: string
  SHOP_ACCESS_TEAM_DOMAIN?: string
  SHOP_ACCESS_AUD?: string
}

export type ShopAccessIdentity =
  { ok: true; email: string } | { ok: false; status: number; message: string }

const DEFAULT_ACCESS_HOSTNAMES = [
  'hatt.acecore.net',
  'www.hatt.acecore.net',
  'homepage-hatt.pages.dev',
  '*.homepage-hatt.pages.dev',
]
const DEFAULT_ACCESS_TEAM_DOMAIN = 'https://acecore.cloudflareaccess.com'
const DEFAULT_ACCESS_AUD =
  '12faf91ff5d66812272272ec869557e4367f7f0a48cb1447f37e4b9e34de9e84'

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function getShopAccessIdentity(
  request: Request,
  env: ShopAccessEnv,
): Promise<ShopAccessIdentity> {
  const hostname = new URL(request.url).hostname.toLowerCase()

  if (!isAllowedAccessHostname(hostname, env)) {
    return {
      ok: false,
      status: 401,
      message:
        'Cloudflare Accessで保護されたショップ管理ドメインからログインしてください。',
    }
  }

  const issuer = normalizeAccessIssuer(
    env.SHOP_ACCESS_TEAM_DOMAIN || DEFAULT_ACCESS_TEAM_DOMAIN,
  )
  const audience = env.SHOP_ACCESS_AUD?.trim() || DEFAULT_ACCESS_AUD

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

  try {
    const { payload } = await jwtVerify(token, getRemoteJwkSet(issuer), {
      algorithms: ['RS256'],
      audience,
      clockTolerance: 60,
      issuer,
    })
    const email =
      typeof payload.email === 'string' ? payload.email.toLowerCase() : ''

    if (!email) {
      return {
        ok: false,
        status: 403,
        message: 'Cloudflare Accessのメールを確認できません。',
      }
    }

    return { ok: true, email }
  } catch {
    return {
      ok: false,
      status: 401,
      message: 'Cloudflare Accessの認証を確認できません。',
    }
  }
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

function isAllowedAccessHostname(hostname: string, env: ShopAccessEnv) {
  return [...DEFAULT_ACCESS_HOSTNAMES, ...parseCsv(env.SHOP_ACCESS_HOSTNAMES)]
    .filter(Boolean)
    .some((pattern) => hostnameMatches(pattern, hostname))
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
