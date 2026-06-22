type Env = {
  CMS_ACCESS_ALLOWED_EMAILS?: string
  CMS_ACCESS_HOSTNAMES?: string
  CMS_GITHUB_TOKEN?: string
}

type PagesContext = {
  request: Request
  env: Env
}

const DEFAULT_OWNER = 'acecore-systems'
const DEFAULT_REPO = 'homepage-hatt'
const DEFAULT_MAIN_BRANCH = 'main'
const COMMITTER = {
  name: 'Hatt Sveltia CMS',
  email: 'cms@acecore.net',
}

const DEFAULT_ACCESS_HOSTNAMES = [
  'hatt.acecore.net',
  'www.hatt.acecore.net',
  'homepage-hatt.pages.dev',
  '*.homepage-hatt.pages.dev',
  'localhost',
  '127.0.0.1',
]

const CONTENT_RULES = [
  { prefix: 'src/content/art/', extension: '.json' },
  { prefix: 'src/content/authors/', extension: '.json' },
  { prefix: 'src/content/blog/', extension: '.md' },
  { prefix: 'src/content/campaigns/', extension: '.json' },
  { prefix: 'src/content/modeling/', extension: '.json' },
  { prefix: 'src/content/tags/', extension: '.json' },
]

const CONTENT_FILES = new Set(['src/content/site/main.json'])

const MEDIA_PREFIX = 'public/uploads/hatt/'
const MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.svg',
  '.webp',
])

class GitHubApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export const onRequest = async ({
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

  const repo = getRepo()
  const method = request.method.toUpperCase()
  const proxyPath = getProxyPath(request)

  try {
    if (method === 'PUT' || method === 'DELETE') {
      return await handleContentWrite({
        auth,
        method,
        proxyPath,
        repo,
        request,
        token,
      })
    }

    if (method !== 'GET' && method !== 'HEAD') {
      return json({ message: 'Method not allowed' }, 405, {
        Allow: 'GET, HEAD, PUT, DELETE',
      })
    }

    if (isCurrentUserPath(proxyPath)) {
      return await handleCurrentUser({ auth, method, repo, token })
    }

    if (isCollaboratorCheckPath(proxyPath, repo)) {
      return noContent()
    }

    if (!isAllowedReadPath(proxyPath, repo)) {
      return json(
        { message: 'CMS proxyで許可されていないGitHub APIです。' },
        403,
      )
    }

    return await proxyGitHubRequest({ method, proxyPath, request, token })
  } catch (error) {
    return toErrorResponse(error)
  }
}

async function handleCurrentUser({
  auth,
  method,
  repo,
  token,
}: {
  auth: { email: string }
  method: string
  repo: Repo
  token: string
}) {
  if (method === 'HEAD') {
    return noContent()
  }

  await githubJson({
    path: `/repos/${repo.owner}/${repo.name}`,
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

async function handleContentWrite({
  auth,
  method,
  proxyPath,
  repo,
  request,
  token,
}: {
  auth: { email: string }
  method: string
  proxyPath: string
  repo: Repo
  request: Request
  token: string
}) {
  const contentPath = getContentPathFromProxyPath(proxyPath, repo)

  if (!contentPath || !isAllowedWritePath(contentPath)) {
    return json({ message: 'CMSで編集できないパスです。' }, 403)
  }

  const payload = parseJsonObject(await request.text())

  if (!payload) {
    return json({ message: 'GitHub Contents API payload が不正です。' }, 400)
  }

  const branch = await createCmsBranch({ contentPath, repo, token })
  const writePayload = {
    ...payload,
    branch,
    message: buildCommitMessage(method, contentPath),
    committer: COMMITTER,
    author: {
      name: auth.email || COMMITTER.name,
      email: COMMITTER.email,
    },
  }
  const encodedPath = encodePathSegments(contentPath)
  const result = await githubJson<Record<string, unknown>>({
    body: writePayload,
    method,
    path: `/repos/${repo.owner}/${repo.name}/contents/${encodedPath}`,
    token,
  })
  const pullRequest = await openPullRequest({
    branch,
    contentPath,
    email: auth.email,
    method,
    repo,
    token,
  })

  return json(
    {
      ...result,
      cms_branch: branch,
      cms_pull_request: {
        number: pullRequest.number,
        html_url: pullRequest.html_url,
      },
    },
    method === 'PUT' ? 201 : 200,
  )
}

async function createCmsBranch({
  contentPath,
  repo,
  token,
}: {
  contentPath: string
  repo: Repo
  token: string
}) {
  const mainRef = await githubJson<{ object: { sha: string } }>({
    path: `/repos/${repo.owner}/${repo.name}/git/ref/heads/${repo.branch}`,
    token,
  })
  const base = sanitizeBranchName(contentPath)

  for (let index = 0; index < 3; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`
    const branch = `cms/hatt/${timestamp()}-${base}${suffix}`

    try {
      await githubJson({
        body: {
          ref: `refs/heads/${branch}`,
          sha: mainRef.object.sha,
        },
        method: 'POST',
        path: `/repos/${repo.owner}/${repo.name}/git/refs`,
        token,
      })

      return branch
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) {
        throw error
      }
    }
  }

  throw new GitHubApiError('CMS保存用branchを作成できませんでした。', 409)
}

async function openPullRequest({
  branch,
  contentPath,
  email,
  method,
  repo,
  token,
}: {
  branch: string
  contentPath: string
  email: string
  method: string
  repo: Repo
  token: string
}) {
  const action = method === 'DELETE' ? 'delete' : 'update'

  return githubJson<{ html_url: string; number: number }>({
    body: {
      base: repo.branch,
      body: [
        'Sveltia CMS の保存を Cloudflare Access 認証済みユーザーから受け付けました。',
        '',
        `- Access user: ${email || '(email headerなし)'}`,
        `- File: \`${contentPath}\``,
        `- Action: ${action}`,
        '',
        'CIで content/schema/build を確認してから main に取り込んでください。',
      ].join('\n'),
      head: branch,
      title: `cms: ${action} ${contentPath}`,
    },
    method: 'POST',
    path: `/repos/${repo.owner}/${repo.name}/pulls`,
    token,
  })
}

async function proxyGitHubRequest({
  method,
  proxyPath,
  request,
  token,
}: {
  method: string
  proxyPath: string
  request: Request
  token: string
}) {
  const sourceUrl = new URL(request.url)
  const targetUrl = new URL(`https://api.github.com/${proxyPath}`)

  targetUrl.search = sourceUrl.search

  const response = await fetch(targetUrl.toString(), {
    method,
    headers: {
      Accept: request.headers.get('Accept') || 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'homepage-hatt-sveltia-cms',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  return copyGitHubResponse(response)
}

async function githubJson<T>({
  body,
  method = 'GET',
  path,
  token,
}: {
  body?: unknown
  method?: string
  path: string
  token: string
}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'homepage-hatt-sveltia-cms',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      data && typeof data.message === 'string'
        ? data.message
        : 'GitHub APIでエラーが発生しました。'

    throw new GitHubApiError(message, response.status)
  }

  return data as T
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

function getRepo() {
  return {
    branch: DEFAULT_MAIN_BRANCH,
    name: DEFAULT_REPO,
    owner: DEFAULT_OWNER,
  }
}

function getProxyPath(request: Request) {
  const pathname = new URL(request.url).pathname

  return pathname
    .replace(/^\/admin\/api\/github\/?/, '')
    .replace(/^api\/v3\/?/, '')
    .replace(/^\/+/, '')
}

function getContentPathFromProxyPath(proxyPath: string, repo: Repo) {
  const prefix = `repos/${repo.owner}/${repo.name}/contents/`

  if (!proxyPath.startsWith(prefix)) return null

  return normalizeEditablePath(
    decodeURIComponent(proxyPath.slice(prefix.length)),
  )
}

function isAllowedReadPath(proxyPath: string, repo: Repo) {
  if (proxyPath === 'user') return true

  const repoRoot = `repos/${repo.owner}/${repo.name}`

  if (proxyPath === repoRoot) return true
  if (!proxyPath.startsWith(`${repoRoot}/`)) return false

  const repoPath = proxyPath.slice(repoRoot.length + 1)

  if (
    repoPath.startsWith('branches') ||
    repoPath.startsWith('commits') ||
    repoPath.startsWith('git/blobs/') ||
    repoPath.startsWith('git/refs/heads/') ||
    repoPath.startsWith('git/trees/')
  ) {
    return true
  }

  if (repoPath === 'contents' || repoPath.startsWith('contents/')) {
    const contentPath = normalizeEditablePath(
      decodeURIComponent(repoPath.replace(/^contents\/?/, '')),
    )

    return (
      contentPath !== null &&
      (contentPath === '' || isReadableContentPath(contentPath))
    )
  }

  return false
}

function isCurrentUserPath(proxyPath: string) {
  return proxyPath === 'user'
}

function isCollaboratorCheckPath(proxyPath: string, repo: Repo) {
  const prefix = `repos/${repo.owner}/${repo.name}/collaborators/`

  if (!proxyPath.startsWith(prefix)) return false

  const login = proxyPath.slice(prefix.length)

  return login.length > 0 && !login.includes('/')
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

function isReadableContentPath(path: string) {
  const parentPrefixes = [
    'src',
    'src/content',
    'src/content/site',
    'public',
    'public/uploads',
  ]

  if (parentPrefixes.includes(path)) return true
  if (path === 'public/uploads/hatt') return true

  return [
    ...CONTENT_RULES.map((rule) => rule.prefix),
    ...Array.from(CONTENT_FILES),
    MEDIA_PREFIX,
  ].some((targetPath) => {
    return path.startsWith(targetPath) || targetPath.startsWith(`${path}/`)
  })
}

function isAllowedWritePath(path: string) {
  if (CONTENT_FILES.has(path)) return true

  if (
    CONTENT_RULES.some((rule) => {
      return path.startsWith(rule.prefix) && path.endsWith(rule.extension)
    })
  ) {
    return true
  }

  if (!path.startsWith(MEDIA_PREFIX)) return false

  return MEDIA_EXTENSIONS.has(getExtension(path))
}

function hostnameMatches(pattern: string, hostname: string) {
  const normalizedPattern = pattern.trim().toLowerCase()

  if (normalizedPattern.startsWith('*.')) {
    return hostname.endsWith(normalizedPattern.slice(1))
  }

  return hostname === normalizedPattern
}

function normalizeEditablePath(path: string | null) {
  if (path === null) return null

  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')

  if (
    normalized === '..' ||
    normalized.includes('../') ||
    normalized.includes('/..')
  ) {
    return null
  }

  return normalized
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

function buildCommitMessage(method: string, contentPath: string) {
  const action = method === 'DELETE' ? 'delete' : 'update'

  return `cms: ${action} ${contentPath}`
}

function sanitizeBranchName(path: string) {
  const base = path
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)

  return base || 'content'
}

function timestamp() {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 14)
}

function encodePathSegments(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

function getExtension(path: string) {
  const fileName = path.split('/').pop() || ''
  const dot = fileName.lastIndexOf('.')

  return dot === -1 ? '' : fileName.slice(dot).toLowerCase()
}

function copyGitHubResponse(response: Response) {
  const headers = new Headers()

  for (const name of ['Content-Type', 'ETag', 'Link']) {
    const value = response.headers.get(name)

    if (value) headers.set(name, value)
  }

  headers.set('Cache-Control', 'no-store')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function toErrorResponse(error: unknown) {
  if (error instanceof GitHubApiError) {
    return json({ message: error.message }, error.status)
  }

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

type Repo = ReturnType<typeof getRepo>
