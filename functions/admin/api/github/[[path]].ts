import { CMS_REPOSITORY } from '../_cms-policy.ts'
import {
  GitHubApiError,
  copyGitHubResponse,
  fetchCmsTree,
  getAllowedCmsBlobShas,
  githubJson,
  githubRequest,
  isRecord,
} from '../_github-api.ts'

type Env = {
  CMS_ACCESS_ALLOWED_EMAILS?: string
  CMS_ACCESS_ALLOWED_DOMAINS?: string
  CMS_ACCESS_HOSTNAMES?: string
  CMS_GITHUB_TOKEN?: string
}

const DEFAULT_ACCESS_HOSTNAMES = [
  'hatt.acecore.net',
  'www.hatt.acecore.net',
  'homepage-hatt.pages.dev',
  '*.homepage-hatt.pages.dev',
  'localhost',
  '127.0.0.1',
]

const SHA_PATTERN = /^[a-f0-9]{40}$/i

type ReadTarget = { kind: 'tree'; ref: string } | { kind: 'blob'; sha: string }

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
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

  const method = request.method.toUpperCase()

  if (method !== 'GET' && method !== 'HEAD') {
    return json({ message: 'Method not allowed' }, 405, {
      Allow: 'GET, HEAD',
    })
  }

  const proxyPath = getProxyPath(request)

  try {
    if (proxyPath === 'user') {
      return await handleCurrentUser({ auth, method, token })
    }

    if (isCollaboratorCheckPath(proxyPath)) {
      return noContent()
    }

    const target = getReadTarget(proxyPath, new URL(request.url))

    if (!target) {
      return json(
        { message: 'CMS proxyで許可されていないGitHub APIです。' },
        403,
      )
    }

    if (target.kind === 'tree') {
      return await handleTreeRead({ method, ref: target.ref, token })
    }

    return await handleBlobRead({ method, request, sha: target.sha, token })
  } catch (error) {
    return toErrorResponse(error)
  }
}

async function handleCurrentUser({
  auth,
  method,
  token,
}: {
  auth: { email: string }
  method: string
  token: string
}) {
  if (method === 'HEAD') {
    return noContent()
  }

  await githubJson({
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}`,
    token,
  })

  return json({
    avatar_url: '',
    email: auth.email,
    html_url: '',
    id: 0,
    login: 'cloudflare-access',
    name: auth.email,
    type: 'User',
  })
}

async function handleTreeRead({
  method,
  ref,
  token,
}: {
  method: string
  ref: string
  token: string
}) {
  if (method === 'HEAD') return noContent()

  const tree = await fetchCmsTree(token, ref)

  return json(tree)
}

async function handleBlobRead({
  method,
  request,
  sha,
  token,
}: {
  method: string
  request: Request
  sha: string
  token: string
}) {
  const tree = await fetchCmsTree(token)

  if (!getAllowedCmsBlobShas(tree).has(sha)) {
    return json({ message: 'CMS管理対象外のGit blobです。' }, 403)
  }

  if (method === 'HEAD') return noContent()

  const response = await githubRequest({
    accept: request.headers.get('Accept') || 'application/vnd.github.raw',
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/blobs/${sha}`,
    token,
  })

  return copyGitHubResponse(response)
}

function getReadTarget(proxyPath: string, sourceUrl: URL): ReadTarget | null {
  const repoRoot = `repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}`
  const treePrefix = `${repoRoot}/git/trees/`
  const blobPrefix = `${repoRoot}/git/blobs/`

  if (proxyPath.startsWith(treePrefix)) {
    const ref = proxyPath.slice(treePrefix.length)
    const queryNames = Array.from(sourceUrl.searchParams.keys())

    if (
      (!SHA_PATTERN.test(ref) && ref !== CMS_REPOSITORY.branch) ||
      queryNames.some((name) => name !== 'recursive') ||
      sourceUrl.searchParams.getAll('recursive').length !== 1 ||
      sourceUrl.searchParams.get('recursive') !== '1'
    ) {
      return null
    }

    return { kind: 'tree', ref }
  }

  if (proxyPath.startsWith(blobPrefix) && sourceUrl.search === '') {
    const sha = proxyPath.slice(blobPrefix.length)

    return SHA_PATTERN.test(sha) ? { kind: 'blob', sha } : null
  }

  return null
}

function getProxyPath(request: Request) {
  const pathname = new URL(request.url).pathname

  return pathname
    .replace(/^\/admin\/api\/github\/?/, '')
    .replace(/^api\/v3\/?/, '')
    .replace(/^\/+/, '')
}

function isCollaboratorCheckPath(proxyPath: string) {
  const prefix = `repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/collaborators/`

  if (!proxyPath.startsWith(prefix)) return false

  const login = proxyPath.slice(prefix.length)

  return login.length > 0 && !login.includes('/')
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
    const data: unknown = JSON.parse(atob(padded))
    const email = isRecord(data) ? data.email : null

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

function toErrorResponse(error: unknown) {
  if (error instanceof GitHubApiError) {
    return json({ message: error.message }, error.status)
  }

  console.error(
    JSON.stringify({
      message: 'CMS GitHub proxy failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  )

  return json({ message: 'CMS GitHub proxyでエラーが発生しました。' }, 500)
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

function noContent() {
  return new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
