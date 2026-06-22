type Env = {
  CMS_ACCESS_ALLOWED_EMAILS?: string
  CMS_ACCESS_ALLOWED_DOMAINS?: string
  CMS_ACCESS_HOSTNAMES?: string
  CMS_GITHUB_TOKEN?: string
}

type PagesContext = {
  request: Request
  env: Env
}

const DEFAULT_ACCESS_HOSTNAMES = [
  'hatt.acecore.net',
  'www.hatt.acecore.net',
  'homepage-hatt.pages.dev',
  '*.homepage-hatt.pages.dev',
  'localhost',
  '127.0.0.1',
]

export const onRequestGet = async ({
  request,
  env,
}: PagesContext): Promise<Response> => {
  const auth = getAccessIdentity(request, env)

  if (!auth.ok) {
    return json({ message: auth.message }, auth.status)
  }

  return json({ email: auth.email })
}

function getAccessIdentity(request: Request, env: Env) {
  const hostname = new URL(request.url).hostname.toLowerCase()

  if (!isAllowedAccessHostname(hostname, env)) {
    return {
      ok: false as const,
      status: 401,
      message:
        'Cloudflare Accessで保護されたCMSドメインからログインしてください。',
    }
  }

  const headerEmail =
    request.headers.get('cf-access-authenticated-user-email') ||
    request.headers.get('Cf-Access-Authenticated-User-Email') ||
    ''
  const jwt =
    request.headers.get('cf-access-jwt-assertion') ||
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    ''
  const email = headerEmail || getAccessJwtEmail(jwt)

  if (!email && !jwt) {
    return {
      ok: false as const,
      status: 401,
      message: 'Cloudflare Accessでログインしてください。',
    }
  }

  if (!email) {
    return {
      ok: false as const,
      status: 403,
      message: 'Cloudflare Accessのメールを確認できません。',
    }
  }

  if (!isAllowedAccessEmail(email, env)) {
    return {
      ok: false as const,
      status: 403,
      message: 'CMS編集が許可されていないCloudflare Accessユーザーです。',
    }
  }

  return { ok: true as const, email }
}

function isAllowedAccessHostname(hostname: string, env: Env) {
  return [...DEFAULT_ACCESS_HOSTNAMES, ...parseCsv(env.CMS_ACCESS_HOSTNAMES)]
    .filter(Boolean)
    .some((pattern) => hostnameMatches(pattern, hostname))
}

function isAllowedAccessEmail(email: string, env: Env) {
  const allowed = parseCsv(env.CMS_ACCESS_ALLOWED_EMAILS)
  const allowedDomains = parseCsv(env.CMS_ACCESS_ALLOWED_DOMAINS)
  const normalizedEmail = email.toLowerCase()
  const domain = normalizedEmail.split('@').pop() || ''

  return allowed.includes(normalizedEmail) || allowedDomains.includes(domain)
}

function getAccessJwtEmail(jwt: string) {
  if (!jwt) return ''

  const payload = jwt.split('.')[1]

  if (!payload) return ''

  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const data = JSON.parse(atob(padded)) as Record<string, unknown>
    const email = data.email

    return typeof email === 'string' ? email : ''
  } catch {
    return ''
  }
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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
