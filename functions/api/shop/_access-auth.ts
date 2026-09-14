import { createRemoteJWKSet, jwtVerify } from 'jose'

export type ShopAccessEnv = {
  SHOP_ACCESS_HOSTNAMES?: string
  SHOP_ACCESS_TEAM_DOMAIN?: string
  SHOP_ACCESS_AUD?: string
}

export type ShopAccessIdentity =
  { ok: true; email: string } | { ok: false; status: number; message: string }
type ShopAccessFailure = Extract<ShopAccessIdentity, { ok: false }>

const DEFAULT_ACCESS_HOSTNAMES = [
  'hatt.acecore.net',
  'www.hatt.acecore.net',
  'homepage-hatt.pages.dev',
  '*.homepage-hatt.pages.dev',
]
const DEFAULT_ACCESS_TEAM_DOMAIN = 'https://acecore.cloudflareaccess.com'
const DEFAULT_ACCESS_AUD =
  '12faf91ff5d66812272272ec869557e4367f7f0a48cb1447f37e4b9e34de9e84'
const ACECORE_SUBJECT_CLAIM = 'https://acecore.net/claims/subject'
const IDENTITY_ACCOUNT_ID = 'db9b62f409f463da7acbcc374b8385d0'
const IDENTITY_PROVIDER_ID = 'a18ae74a-a342-40db-bfb2-7cc515d26637'
const MAX_ACCESS_TOKEN_LENGTH = 32 * 1024
const MAX_IDENTITY_RESPONSE_BYTES = 64 * 1024
const IDENTITY_REQUEST_TIMEOUT_MS = 8 * 1000
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function getShopAccessIdentity(
  request: Request,
  env: ShopAccessEnv,
): Promise<ShopAccessIdentity> {
  const hostname = new URL(request.url).hostname.toLowerCase()

  if (!isAllowedShopAccessHostname(hostname, env)) {
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

  if (!token || token.length > MAX_ACCESS_TOKEN_LENGTH) {
    return {
      ok: false,
      status: 401,
      message: 'Cloudflare Accessでログインしてください。',
    }
  }

  let payload
  try {
    payload = (
      await jwtVerify(token, getRemoteJwkSet(issuer), {
        algorithms: ['RS256'],
        audience,
        clockTolerance: 60,
        issuer,
        requiredClaims: ['exp', 'iat', 'sub'],
      })
    ).payload
  } catch {
    return {
      ok: false,
      status: 401,
      message: 'Cloudflare Accessの認証を確認できません。',
    }
  }

  if (
    payload.type !== 'app' ||
    typeof payload.sub !== 'string' ||
    !UUID_PATTERN.test(payload.sub)
  ) {
    return acecoreIdentityRejected(403)
  }

  const custom = payload.custom
  if (custom !== undefined && !isRecord(custom)) {
    return acecoreIdentityRejected(403)
  }

  const directSubject = (custom || {})[ACECORE_SUBJECT_CLAIM]
  if (directSubject !== undefined) {
    if (
      typeof directSubject !== 'string' ||
      !UUID_PATTERN.test(directSubject)
    ) {
      return acecoreIdentityRejected(403)
    }
  } else {
    const identity = await getFullIdentity(issuer, token)
    if (!identity.ok) return identity
    const identityIdp = identity.value.idp
    const identityFields = identity.value.oidc_fields
    const identitySubject = isRecord(identityFields)
      ? identityFields[ACECORE_SUBJECT_CLAIM]
      : undefined
    if (
      identity.value.user_uuid !== payload.sub ||
      identity.value.account_id !== IDENTITY_ACCOUNT_ID ||
      !isRecord(identityIdp) ||
      identityIdp.id !== IDENTITY_PROVIDER_ID ||
      identityIdp.type !== 'oidc' ||
      typeof identitySubject !== 'string' ||
      !UUID_PATTERN.test(identitySubject)
    ) {
      return acecoreIdentityRejected(403)
    }
  }

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
}

async function getFullIdentity(
  issuer: string,
  token: string,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; message: string }
> {
  let response: Response
  try {
    response = await fetch(
      new URL('/cdn-cgi/access/get-identity', `${issuer}/`),
      {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          Cookie: `CF_Authorization=${token}`,
        },
      },
    )
  } catch {
    return acecoreIdentityRejected(502)
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return acecoreIdentityRejected(502)
  }

  const identity = await readBoundedJson(response)
  if (!isRecord(identity)) return acecoreIdentityRejected(502)
  return { ok: true, value: identity }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_IDENTITY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }

    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }

    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    )
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}

function acecoreIdentityRejected(status: number): ShopAccessFailure {
  return {
    ok: false,
    status,
    message:
      status === 502
        ? 'AcecoreIDの認証情報を確認できません。時間をおいて再ログインしてください。'
        : 'AcecoreIDでログインしてください。',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

export function isAllowedShopAccessHostname(
  hostname: string,
  env: ShopAccessEnv,
) {
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
