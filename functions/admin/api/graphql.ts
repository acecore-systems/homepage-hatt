type Env = {
  CMS_ACCESS_ALLOWED_EMAILS?: string
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

export const onRequestPost = async ({
  request,
  env,
}: PagesContext): Promise<Response> => {
  const auth = getAccessIdentity(request, env)

  if (!auth.ok) {
    return json({ message: auth.message }, auth.status)
  }

  const token = env.CMS_GITHUB_TOKEN?.trim()

  if (!token) {
    return json(
      { message: 'CMS_GITHUB_TOKEN がCloudflare Pagesに設定されていません。' },
      503,
    )
  }

  const bodyText = await request.text()
  const payload = parseJsonObject(bodyText)
  const query = typeof payload?.query === 'string' ? payload.query : ''

  if (!query || /\bmutation\b/i.test(query)) {
    return json(
      { message: 'CMS GraphQL proxy は読み取りqueryのみ許可します。' },
      403,
    )
  }

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'homepage-hatt-sveltia-cms',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: bodyText,
  })

  return copyGitHubResponse(response)
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

  return allowed.includes(email.toLowerCase())
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

function parseJsonObject(text: string) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function copyGitHubResponse(response: Response) {
  const headers = new Headers()
  const contentType = response.headers.get('Content-Type')

  if (contentType) headers.set('Content-Type', contentType)
  headers.set('Cache-Control', 'no-store')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}
