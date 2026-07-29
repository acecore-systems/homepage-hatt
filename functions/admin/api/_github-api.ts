import { SignJWT, importPKCS8 } from 'jose'

import {
  CMS_REPOSITORY,
  isAllowedCmsDirectoryPath,
  isAllowedCmsWritePath,
  isCmsReferenceStatePath,
  isCmsReferenceTextPath,
  normalizeCmsPath,
} from './_cms-policy.ts'
import { MAX_CMS_TEXT_FILE_BYTES } from './_cms-content-validator.ts'

const GITHUB_API_VERSION = '2022-11-28'
const USER_AGENT = 'homepage-hatt-sveltia-cms'
const INSTALLATION_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
const MAX_REFERENCE_STATE_ENTRIES = 5_000
const MAX_REFERENCE_TEXT_BLOBS = 600
const MAX_REFERENCE_TEXT_BYTES = 32 * 1024 * 1024
const REFERENCE_BLOB_BATCH_SIZE = 100
const SHA_PATTERN = /^[a-f0-9]{40}$/i

type GitHubAuthEnv = {
  CMS_GITHUB_APP_CLIENT_ID?: string
  CMS_GITHUB_APP_INSTALLATION_ID?: string
  CMS_GITHUB_APP_PRIVATE_KEY?: string
}

const installationTokenCache = new Map<
  string,
  { token: string; expiresAt: number }
>()

export class GitHubApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function getGitHubToken(
  env: GitHubAuthEnv,
  { fresh = false }: { fresh?: boolean } = {},
) {
  const clientId = env.CMS_GITHUB_APP_CLIENT_ID?.trim()
  const installationId = env.CMS_GITHUB_APP_INSTALLATION_ID?.trim()
  const privateKey = env.CMS_GITHUB_APP_PRIVATE_KEY?.replace(
    /\\n/g,
    '\n',
  ).trim()

  if (
    !clientId ||
    !installationId ||
    !/^\d+$/.test(installationId) ||
    !privateKey
  ) {
    throw new GitHubApiError(
      'CMS GitHub Appの認証設定がCloudflare Pagesにありません。',
      503,
    )
  }

  const cacheKey = `${clientId}:${installationId}`
  const cached = installationTokenCache.get(cacheKey)

  if (
    !fresh &&
    cached &&
    cached.expiresAt - INSTALLATION_TOKEN_REFRESH_BUFFER_MS > Date.now()
  ) {
    return cached.token
  }

  let appJwt: string

  try {
    const signingKey = await importPKCS8(privateKey, 'RS256')
    const now = Math.floor(Date.now() / 1000)

    appJwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(clientId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .sign(signingKey)
  } catch {
    throw new GitHubApiError('CMS GitHub Appの秘密鍵を読み込めません。', 503)
  }

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({
        repositories: [CMS_REPOSITORY.name],
        permissions: {
          contents: 'write',
        },
      }),
    },
  )
  const data: unknown = await response.json().catch(() => null)

  if (
    !response.ok ||
    !isRecord(data) ||
    typeof data.token !== 'string' ||
    typeof data.expires_at !== 'string' ||
    !hasExpectedInstallationTokenScope(data)
  ) {
    const message =
      isRecord(data) && typeof data.message === 'string'
        ? data.message
        : 'CMS GitHub Appのinstallation tokenを発行できません。'

    throw new GitHubApiError(message, response.ok ? 502 : response.status)
  }

  const expiresAt = Date.parse(data.expires_at)

  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new GitHubApiError(
      'CMS GitHub Appのinstallation token有効期限が不正です。',
      502,
    )
  }

  installationTokenCache.set(cacheKey, { token: data.token, expiresAt })

  return data.token
}

function hasExpectedInstallationTokenScope(data: Record<string, unknown>) {
  if (!isRecord(data.permissions) || data.permissions.contents !== 'write') {
    return false
  }

  if (
    Object.entries(data.permissions).some(([name, permission]) => {
      if (name === 'contents') return permission !== 'write'
      if (name === 'metadata') return permission !== 'read'

      return permission !== 'none'
    })
  ) {
    return false
  }

  if (!Array.isArray(data.repositories) || data.repositories.length !== 1) {
    return false
  }

  const repository = data.repositories[0]

  return (
    isRecord(repository) &&
    repository.full_name === `${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}`
  )
}

export type CmsGitTreeItem = {
  path: string
  mode: string
  type: 'blob' | 'tree'
  sha: string
  size?: number
  url?: string
}

export type CmsGitTree = {
  sha: string
  tree: CmsGitTreeItem[]
  truncated: boolean
  url?: string
}

export type CmsReferenceStateEntry = {
  path: string
  contents?: string
}

export async function githubRequest({
  accept = 'application/vnd.github+json',
  body,
  method = 'GET',
  path,
  token,
}: {
  accept?: string
  body?: unknown
  method?: string
  path: string
  token: string
}) {
  const headers = new Headers({
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  })

  if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }

  return fetch(`https://api.github.com${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export async function githubJson<T>(
  options: Parameters<typeof githubRequest>[0],
) {
  const response = await githubRequest(options)
  const data: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      isRecord(data) && typeof data.message === 'string'
        ? data.message
        : 'GitHub APIでエラーが発生しました。'

    throw new GitHubApiError(message, response.status)
  }

  return data as T
}

export async function fetchCmsTree(
  token: string,
  ref: string = CMS_REPOSITORY.branch,
) {
  const data = await githubJson<unknown>({
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    token,
  })

  if (
    !isRecord(data) ||
    typeof data.sha !== 'string' ||
    !Array.isArray(data.tree) ||
    typeof data.truncated !== 'boolean'
  ) {
    throw new GitHubApiError('GitHub tree response が不正です。', 502)
  }

  if (data.truncated) {
    throw new GitHubApiError(
      'GitHub tree が省略されたためCMS対象を安全に判定できません。',
      502,
    )
  }

  const tree = data.tree.flatMap((item): CmsGitTreeItem[] => {
    if (!isRecord(item)) return []

    const path =
      typeof item.path === 'string' ? normalizeCmsPath(item.path) : null
    const type = item.type
    const sha = item.sha
    const mode = item.mode

    if (
      !path ||
      (type !== 'blob' && type !== 'tree') ||
      typeof sha !== 'string' ||
      typeof mode !== 'string'
    ) {
      return []
    }

    const allowed =
      type === 'blob'
        ? isAllowedCmsWritePath(path)
        : isAllowedCmsDirectoryPath(path)

    if (!allowed) return []

    return [
      {
        path,
        type,
        sha,
        mode,
        ...(typeof item.size === 'number' ? { size: item.size } : {}),
        ...(typeof item.url === 'string' ? { url: item.url } : {}),
      },
    ]
  })

  return {
    sha: data.sha,
    tree,
    truncated: data.truncated,
    ...(typeof data.url === 'string' ? { url: data.url } : {}),
  } satisfies CmsGitTree
}

export async function fetchCmsReferenceState(
  token: string,
  ref: string = CMS_REPOSITORY.branch,
) {
  const data = await githubJson<unknown>({
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    token,
  })

  if (
    !isRecord(data) ||
    !Array.isArray(data.tree) ||
    typeof data.truncated !== 'boolean'
  ) {
    throw new GitHubApiError('GitHub tree response が不正です。', 502)
  }

  if (data.truncated) {
    throw new GitHubApiError(
      'GitHub tree が省略されたためCMS参照を安全に検証できません。',
      502,
    )
  }

  const blobs: Array<{ path: string; sha: string; size?: number }> = []
  const paths = new Set<string>()

  for (const item of data.tree) {
    if (!isRecord(item) || typeof item.path !== 'string') continue

    const path = normalizeCmsPath(item.path)
    const inReferenceNamespace = isCmsReferenceNamespace(
      item.path.replace(/\\/g, '/').replace(/^\/+/, ''),
    )

    if (!path || path !== item.path) {
      if (inReferenceNamespace) {
        throw new GitHubApiError('GitHub上のCMS参照pathが不正です。', 502)
      }

      continue
    }

    if (!isCmsReferenceStatePath(path)) continue

    if (
      item.type !== 'blob' ||
      typeof item.sha !== 'string' ||
      !SHA_PATTERN.test(item.sha) ||
      (item.size !== undefined &&
        (typeof item.size !== 'number' ||
          !Number.isSafeInteger(item.size) ||
          item.size < 0)) ||
      paths.has(path)
    ) {
      throw new GitHubApiError('GitHub上のCMS参照状態が不正です。', 502)
    }

    paths.add(path)
    blobs.push({
      path,
      sha: item.sha,
      ...(typeof item.size === 'number' ? { size: item.size } : {}),
    })
  }

  if (blobs.length > MAX_REFERENCE_STATE_ENTRIES) {
    throw new GitHubApiError(
      'CMS参照状態が検証上限を超えたため保存を停止しました。',
      503,
    )
  }

  const textBlobsBySha = new Map<
    string,
    { sha: string; size?: number; paths: string[] }
  >()

  for (const blob of blobs) {
    if (!isCmsReferenceTextPath(blob.path)) continue

    if (blob.size !== undefined && blob.size > MAX_CMS_TEXT_FILE_BYTES) {
      throw new GitHubApiError(
        `CMS参照元が448 KiBを超えています: ${blob.path}`,
        503,
      )
    }

    const existing = textBlobsBySha.get(blob.sha)

    if (existing) {
      if (
        existing.size !== undefined &&
        blob.size !== undefined &&
        existing.size !== blob.size
      ) {
        throw new GitHubApiError('GitHub上のCMS参照状態が不正です。', 502)
      }

      if (existing.size === undefined && blob.size !== undefined) {
        existing.size = blob.size
      }

      existing.paths.push(blob.path)
    } else {
      textBlobsBySha.set(blob.sha, {
        sha: blob.sha,
        ...(blob.size === undefined ? {} : { size: blob.size }),
        paths: [blob.path],
      })
    }
  }

  const textBlobs = Array.from(textBlobsBySha.values())
  const estimatedBytes = textBlobs.reduce(
    (total, blob) => total + (blob.size ?? 0),
    0,
  )

  if (
    textBlobs.length > MAX_REFERENCE_TEXT_BLOBS ||
    estimatedBytes > MAX_REFERENCE_TEXT_BYTES
  ) {
    throw new GitHubApiError(
      'CMS参照元が検証上限を超えたため保存を停止しました。',
      503,
    )
  }

  const contentsBySha = await fetchReferenceBlobTexts(token, textBlobs)

  return blobs.map((blob): CmsReferenceStateEntry => {
    if (!isCmsReferenceTextPath(blob.path)) return { path: blob.path }

    const contents = contentsBySha.get(blob.sha)

    if (contents === undefined) {
      throw new GitHubApiError(
        `GitHub上のCMS参照元を読み込めません: ${blob.path}`,
        502,
      )
    }

    return { path: blob.path, contents }
  })
}

function isCmsReferenceNamespace(path: string) {
  return (
    path === 'src/content/site/main.json' ||
    path.startsWith('src/content/art/') ||
    path.startsWith('src/content/authors/') ||
    path.startsWith('src/content/blog/') ||
    path.startsWith('src/content/campaigns/') ||
    path.startsWith('src/content/modeling/') ||
    path.startsWith('src/content/tags/') ||
    path.startsWith('public/uploads/hatt/')
  )
}

async function fetchReferenceBlobTexts(
  token: string,
  blobs: readonly { sha: string; size?: number; paths: string[] }[],
) {
  const contentsBySha = new Map<string, string>()
  let fetchedBytes = 0

  for (
    let offset = 0;
    offset < blobs.length;
    offset += REFERENCE_BLOB_BATCH_SIZE
  ) {
    const batch = blobs.slice(offset, offset + REFERENCE_BLOB_BATCH_SIZE)
    const fields = batch
      .map(
        ({ sha }, index) =>
          `blob${index}: object(oid: "${sha}") { ... on Blob { byteSize isBinary isTruncated text } }`,
      )
      .join('\n')
    const result = await githubJson<unknown>({
      body: {
        query: `query CmsReferenceState {
          repository(owner: "${CMS_REPOSITORY.owner}", name: "${CMS_REPOSITORY.name}") {
            ${fields}
          }
        }`,
        variables: {},
      },
      method: 'POST',
      path: '/graphql',
      token,
    })
    const data = isRecord(result) && isRecord(result.data) ? result.data : null
    const repository =
      data && isRecord(data.repository) ? data.repository : null

    if (!repository || (isRecord(result) && Array.isArray(result.errors))) {
      throw new GitHubApiError('GitHub上のCMS参照元を読み込めません。', 502)
    }

    for (const [index, blob] of batch.entries()) {
      const value = repository[`blob${index}`]

      if (
        !isRecord(value) ||
        value.isBinary !== false ||
        value.isTruncated !== false ||
        typeof value.byteSize !== 'number' ||
        !Number.isInteger(value.byteSize) ||
        value.byteSize < 0 ||
        value.byteSize > MAX_CMS_TEXT_FILE_BYTES ||
        typeof value.text !== 'string' ||
        new TextEncoder().encode(value.text).byteLength !== value.byteSize ||
        (blob.size !== undefined && blob.size !== value.byteSize)
      ) {
        throw new GitHubApiError(
          `GitHub上のCMS参照元を読み込めません: ${blob.paths[0]}`,
          502,
        )
      }

      fetchedBytes += value.byteSize

      if (fetchedBytes > MAX_REFERENCE_TEXT_BYTES) {
        throw new GitHubApiError(
          'CMS参照元が検証上限を超えたため保存を停止しました。',
          503,
        )
      }

      contentsBySha.set(blob.sha, value.text)
    }
  }

  return contentsBySha
}

export function getAllowedCmsBlobShas(tree: CmsGitTree) {
  return new Set(
    tree.tree.filter((item) => item.type === 'blob').map((item) => item.sha),
  )
}

export function copyGitHubResponse(response: Response) {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
