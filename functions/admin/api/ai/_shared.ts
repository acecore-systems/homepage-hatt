import { CMS_REPOSITORY } from '../_cms-policy.ts'
import {
  GitHubApiError,
  getGitHubToken,
  githubRequest,
  isRecord,
} from '../_github-api.ts'
import type { CmsAccessEnv } from '../_access-auth.ts'

export const CMS_AI_MODEL = '@cf/zai-org/glm-5.3-flash'
export const CMS_AI_RUNNER_AUDIENCE =
  'https://hatt.acecore.net/admin/api/ai/runner'
export const CMS_AI_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const CMS_AI_JOB_STATUSES = [
  'queued',
  'running',
  'validating',
  'needs_input',
  'failed',
  'pr_created',
  'merged',
] as const

export type CmsAiJobStatus = (typeof CMS_AI_JOB_STATUSES)[number]

export type CmsAiPreparedStatement = {
  bind(...values: unknown[]): CmsAiPreparedStatement
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>
  run(): Promise<{ meta?: { changes?: number } }>
}

export type CmsAiDatabase = {
  prepare(query: string): CmsAiPreparedStatement
}

export type CmsAiR2ObjectBody = {
  arrayBuffer(): Promise<ArrayBuffer>
}

export type CmsAiR2Bucket = {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string }
      customMetadata?: Record<string, string>
    },
  ): Promise<unknown>
  get(key: string): Promise<CmsAiR2ObjectBody | null>
  delete(keys: string | string[]): Promise<void>
}

export type CmsAiBinding = {
  run(model: string, input: unknown): Promise<unknown>
}

export type CmsAiEnv = CmsAccessEnv & {
  AI?: CmsAiBinding
  CMS_AI_ASSETS?: CmsAiR2Bucket
  CMS_AI_AUTOMERGE_ENABLED?: string
  CMS_AI_DB?: CmsAiDatabase
  CMS_AI_GITHUB_OIDC_ISSUER?: string
  CMS_AI_MODEL?: string
  CMS_AI_RUNNER_AUDIENCE?: string
  CMS_AI_TARGET_HOSTNAMES?: string
}

export type CmsAiAttachment = {
  bytes: number
  contentType: 'image/jpeg' | 'image/png' | 'image/webp'
  fileName: string
  key: string
}

export type CmsAiJob = {
  attachmentJson: string
  attachments: CmsAiAttachment[]
  branchName: string
  changedPaths: string[]
  clarification: string | null
  createdAt: string
  deploymentUrl: string | null
  errorMessage: string | null
  id: string
  instruction: string
  prUrl: string | null
  requestedBy: string
  status: CmsAiJobStatus
  summary: string | null
  targetUrl: string
  updatedAt: string
}

type CmsAiJobRow = {
  attachment_json: string
  branch_name: string
  changed_paths_json: string
  clarification: string | null
  created_at: string
  deployment_url: string | null
  error_message: string | null
  id: string
  instruction: string
  pr_url: string | null
  requested_by: string
  status: string
  summary: string | null
  target_url: string
  updated_at: string
}

const DEFAULT_TARGET_HOSTNAMES = [
  'hatt.acecore.net',
  'www.hatt.acecore.net',
  'homepage-hatt.pages.dev',
]
const MAX_TARGET_URL_LENGTH = 2_048
const MAX_INSTRUCTION_LENGTH = 4_000
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024

export class CmsAiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

export function methodNotAllowed(methods: string[]) {
  return json({ message: 'Method not allowed' }, 405, {
    Allow: methods.join(', '),
  })
}

export function getCmsAiDb(env: CmsAiEnv) {
  if (!env.CMS_AI_DB) {
    throw new CmsAiError(503, 'CMS AIジョブの保存先が設定されていません。')
  }

  return env.CMS_AI_DB
}

export function getCmsAiAssets(env: CmsAiEnv) {
  if (!env.CMS_AI_ASSETS) {
    throw new CmsAiError(503, 'CMS AI参照画像の保存先が設定されていません。')
  }

  return env.CMS_AI_ASSETS
}

export function getCmsAiBinding(env: CmsAiEnv) {
  if (!env.AI || typeof env.AI.run !== 'function') {
    throw new CmsAiError(503, 'Workers AI bindingが設定されていません。')
  }

  return env.AI
}

export function normalizeTargetUrl(value: unknown, env: CmsAiEnv) {
  const source = String(value || '').trim()

  if (!source || source.length > MAX_TARGET_URL_LENGTH) {
    throw new CmsAiError(400, '対象URLを入力してください。')
  }

  let url: URL

  try {
    url = new URL(source)
  } catch {
    throw new CmsAiError(400, '対象URLの形式を確認してください。')
  }

  const hostname = url.hostname.toLowerCase()
  const allowedHostnames = getTargetHostnames(env)
  const isPreviewHostname = hostname.endsWith('.homepage-hatt.pages.dev')

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (!allowedHostnames.includes(hostname) && !isPreviewHostname)
  ) {
    throw new CmsAiError(
      403,
      'Hattの管理対象ドメインのURLだけを指定してください。',
    )
  }

  if (url.search.length > 512) {
    throw new CmsAiError(400, '対象URLのqueryが長すぎます。')
  }

  url.hash = ''
  return url.toString()
}

export function normalizeInstruction(value: unknown) {
  const instruction = String(value || '').trim()

  if (!instruction || instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw new CmsAiError(400, '依頼内容を1〜4000文字で入力してください。')
  }

  return instruction
}

export function assertSameOriginRequest(request: Request) {
  const origin = request.headers.get('Origin')

  if (!origin) return

  let originUrl: URL

  try {
    originUrl = new URL(origin)
  } catch {
    throw new CmsAiError(403, '許可されていないリクエストです。')
  }

  const requestUrl = new URL(request.url)

  if (originUrl.origin !== requestUrl.origin) {
    throw new CmsAiError(403, '許可されていないリクエストです。')
  }
}

export function validateReferenceImage(file: {
  arrayBuffer(): Promise<ArrayBuffer>
  name?: string
  size?: number
  type?: string
}) {
  const contentType = String(file.type || '').toLowerCase()

  if (
    contentType !== 'image/jpeg' &&
    contentType !== 'image/png' &&
    contentType !== 'image/webp'
  ) {
    throw new CmsAiError(
      400,
      '参考画像はPNG、JPEG、WebPのいずれかにしてください。',
    )
  }

  const size = Number(file.size)

  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
    throw new CmsAiError(400, '参考画像は2 MiB以下にしてください。')
  }

  return {
    contentType: contentType as CmsAiAttachment['contentType'],
    fileName: sanitizeFileName(String(file.name || 'reference-image')),
  }
}

export async function assertReferenceImageSignature(
  bytes: ArrayBuffer,
  contentType: CmsAiAttachment['contentType'],
) {
  const view = new Uint8Array(bytes)

  const matchesPng =
    view.length >= 8 &&
    view[0] === 0x89 &&
    view[1] === 0x50 &&
    view[2] === 0x4e &&
    view[3] === 0x47 &&
    view[4] === 0x0d &&
    view[5] === 0x0a &&
    view[6] === 0x1a &&
    view[7] === 0x0a
  const matchesJpeg =
    view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff
  const matchesWebp =
    view.length >= 12 &&
    asAscii(view.slice(0, 4)) === 'RIFF' &&
    asAscii(view.slice(8, 12)) === 'WEBP'

  const valid =
    (contentType === 'image/png' && matchesPng) ||
    (contentType === 'image/jpeg' && matchesJpeg) ||
    (contentType === 'image/webp' && matchesWebp)

  if (!valid) {
    throw new CmsAiError(400, '参考画像の形式とファイル内容が一致しません。')
  }
}

export function createJobId() {
  return crypto.randomUUID()
}

export function createBranchName(jobId: string) {
  assertJobId(jobId)
  return 'ai/cms-' + jobId
}

export function createAttachmentKey(
  jobId: string,
  contentType: CmsAiAttachment['contentType'],
) {
  assertJobId(jobId)
  const extension =
    contentType === 'image/png'
      ? 'png'
      : contentType === 'image/webp'
        ? 'webp'
        : 'jpg'

  return 'cms-ai/jobs/' + jobId + '/reference.' + extension
}

export async function createCmsAiJob(
  env: CmsAiEnv,
  input: {
    attachments: CmsAiAttachment[]
    id: string
    instruction: string
    requestedBy: string
    targetUrl: string
  },
) {
  const db = getCmsAiDb(env)
  const now = new Date().toISOString()
  const branchName = createBranchName(input.id)

  await db
    .prepare(
      [
        'INSERT INTO cms_ai_jobs (',
        'id, requested_by, target_url, instruction, attachment_json, status,',
        'branch_name, changed_paths_json, created_at, updated_at',
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ].join(' '),
    )
    .bind(
      input.id,
      input.requestedBy,
      input.targetUrl,
      input.instruction,
      JSON.stringify(input.attachments),
      'queued',
      branchName,
      '[]',
      now,
      now,
    )
    .run()

  return {
    attachmentJson: JSON.stringify(input.attachments),
    attachments: input.attachments,
    branchName,
    changedPaths: [],
    clarification: null,
    createdAt: now,
    deploymentUrl: null,
    errorMessage: null,
    id: input.id,
    instruction: input.instruction,
    prUrl: null,
    requestedBy: input.requestedBy,
    status: 'queued' as const,
    summary: null,
    targetUrl: input.targetUrl,
    updatedAt: now,
  } satisfies CmsAiJob
}

export async function getCmsAiJob(
  env: CmsAiEnv,
  jobId: string,
  requestedBy?: string,
) {
  assertJobId(jobId)
  const db = getCmsAiDb(env)
  const statement = requestedBy
    ? db
        .prepare(
          [
            'SELECT id, requested_by, target_url, instruction, attachment_json,',
            'status, branch_name, summary, clarification, pr_url, deployment_url,',
            'changed_paths_json, error_message, created_at, updated_at',
            'FROM cms_ai_jobs WHERE id = ? AND requested_by = ? LIMIT 1',
          ].join(' '),
        )
        .bind(jobId, requestedBy)
    : db
        .prepare(
          [
            'SELECT id, requested_by, target_url, instruction, attachment_json,',
            'status, branch_name, summary, clarification, pr_url, deployment_url,',
            'changed_paths_json, error_message, created_at, updated_at',
            'FROM cms_ai_jobs WHERE id = ? LIMIT 1',
          ].join(' '),
        )
        .bind(jobId)
  const row = await statement.first<CmsAiJobRow>()

  return row ? parseCmsAiJob(row) : null
}

export async function updateCmsAiJob(
  env: CmsAiEnv,
  jobId: string,
  update: {
    changedPaths?: string[]
    clarification?: string | null
    deploymentUrl?: string | null
    errorMessage?: string | null
    prUrl?: string | null
    status?: CmsAiJobStatus
    summary?: string | null
  },
) {
  assertJobId(jobId)
  const job = await getCmsAiJob(env, jobId)

  if (!job) {
    throw new CmsAiError(404, 'CMS AIジョブが見つかりません。')
  }

  const next = {
    changedPaths:
      'changedPaths' in update ? (update.changedPaths ?? []) : job.changedPaths,
    clarification:
      'clarification' in update
        ? (update.clarification ?? null)
        : job.clarification,
    deploymentUrl:
      'deploymentUrl' in update
        ? (update.deploymentUrl ?? null)
        : job.deploymentUrl,
    errorMessage:
      'errorMessage' in update
        ? (update.errorMessage ?? null)
        : job.errorMessage,
    prUrl: 'prUrl' in update ? (update.prUrl ?? null) : job.prUrl,
    status: update.status ?? job.status,
    summary: 'summary' in update ? (update.summary ?? null) : job.summary,
  }
  const updatedAt = new Date().toISOString()

  await getCmsAiDb(env)
    .prepare(
      [
        'UPDATE cms_ai_jobs SET status = ?, summary = ?, clarification = ?,',
        'pr_url = ?, deployment_url = ?, changed_paths_json = ?, error_message = ?,',
        'updated_at = ? WHERE id = ?',
      ].join(' '),
    )
    .bind(
      next.status,
      limitOptionalText(next.summary, 4_000),
      limitOptionalText(next.clarification, 4_000),
      normalizeGithubUrl(next.prUrl),
      normalizeHttpsUrl(next.deploymentUrl),
      JSON.stringify(normalizeChangedPaths(next.changedPaths)),
      limitOptionalText(next.errorMessage, 2_000),
      updatedAt,
      jobId,
    )
    .run()

  return {
    ...job,
    changedPaths: normalizeChangedPaths(next.changedPaths),
    clarification: limitOptionalText(next.clarification, 4_000),
    deploymentUrl: normalizeHttpsUrl(next.deploymentUrl),
    errorMessage: limitOptionalText(next.errorMessage, 2_000),
    prUrl: normalizeGithubUrl(next.prUrl),
    status: next.status,
    summary: limitOptionalText(next.summary, 4_000),
    updatedAt,
  } satisfies CmsAiJob
}

export async function deleteCmsAiJob(env: CmsAiEnv, jobId: string) {
  assertJobId(jobId)
  await getCmsAiDb(env)
    .prepare('DELETE FROM cms_ai_jobs WHERE id = ?')
    .bind(jobId)
    .run()
}

export async function dispatchCmsAiJob(env: CmsAiEnv, jobId: string) {
  assertJobId(jobId)
  const token = await getGitHubToken(env, { fresh: true })
  const response = await githubRequest({
    body: {
      client_payload: { job_id: jobId },
      event_type: 'cms-ai-job',
    },
    method: 'POST',
    path:
      '/repos/' +
      CMS_REPOSITORY.owner +
      '/' +
      CMS_REPOSITORY.name +
      '/dispatches',
    token,
  })

  if (response.ok) return

  const body: unknown = await response.json().catch(() => null)
  const message =
    isRecord(body) && typeof body.message === 'string'
      ? body.message
      : 'GitHub Actionsを起動できません。'

  throw new GitHubApiError(message, response.status || 502)
}

export function toPublicCmsAiJob(job: CmsAiJob) {
  return {
    attachmentCount: job.attachments.length,
    attachmentNames: job.attachments.map((attachment) => attachment.fileName),
    changedPaths: job.changedPaths,
    clarification: job.clarification,
    createdAt: job.createdAt,
    deploymentUrl: job.deploymentUrl,
    errorMessage: job.errorMessage,
    id: job.id,
    prUrl: job.prUrl,
    status: job.status,
    summary: job.summary,
    targetUrl: job.targetUrl,
    updatedAt: job.updatedAt,
  }
}

export function isCmsAiJobStatus(value: unknown): value is CmsAiJobStatus {
  return (
    typeof value === 'string' &&
    (CMS_AI_JOB_STATUSES as readonly string[]).includes(value)
  )
}

export function isAutoMergeEnabled(env: CmsAiEnv) {
  return String(env.CMS_AI_AUTOMERGE_ENABLED || '').trim() === 'true'
}

export function getRunnerAudience(env: CmsAiEnv) {
  const configured = String(env.CMS_AI_RUNNER_AUDIENCE || '').trim()

  if (!configured) return CMS_AI_RUNNER_AUDIENCE

  try {
    const url = new URL(configured)

    return url.protocol === 'https:' && !url.username && !url.password
      ? url.toString().replace(/\/$/, '')
      : CMS_AI_RUNNER_AUDIENCE
  } catch {
    return CMS_AI_RUNNER_AUDIENCE
  }
}

export function getCmsAiModel(env: CmsAiEnv) {
  const configured = String(env.CMS_AI_MODEL || '').trim()
  return configured || CMS_AI_MODEL
}

export function assertJobId(jobId: string) {
  if (!CMS_AI_JOB_ID_PATTERN.test(jobId)) {
    throw new CmsAiError(400, 'CMS AIジョブIDを確認してください。')
  }
}

export function toCmsAiErrorResponse(error: unknown, event: string) {
  if (error instanceof CmsAiError) {
    return json({ message: error.message }, error.status)
  }

  if (error instanceof GitHubApiError) {
    return json(
      {
        message:
          'GitHub Actionsの開始に失敗しました。時間をおいて再試行してください。',
      },
      error.status >= 400 && error.status < 600 ? error.status : 502,
    )
  }

  console.error(
    JSON.stringify({
      event,
      error: error instanceof Error ? error.message : String(error),
    }),
  )

  return json(
    {
      message: 'CMS AIを処理できませんでした。時間をおいて再試行してください。',
    },
    500,
  )
}

function parseCmsAiJob(row: CmsAiJobRow) {
  const status = isCmsAiJobStatus(row.status) ? row.status : 'failed'

  return {
    attachmentJson: row.attachment_json,
    attachments: parseAttachments(row.attachment_json),
    branchName: row.branch_name,
    changedPaths: parseChangedPaths(row.changed_paths_json),
    clarification: limitOptionalText(row.clarification, 4_000),
    createdAt: row.created_at,
    deploymentUrl: normalizeHttpsUrl(row.deployment_url),
    errorMessage: limitOptionalText(row.error_message, 2_000),
    id: row.id,
    instruction: row.instruction,
    prUrl: normalizeGithubUrl(row.pr_url),
    requestedBy: row.requested_by,
    status,
    summary: limitOptionalText(row.summary, 4_000),
    targetUrl: row.target_url,
    updatedAt: row.updated_at,
  } satisfies CmsAiJob
}

function parseAttachments(value: string) {
  const parsed = parseJson(value)

  if (!Array.isArray(parsed)) return []

  return parsed.flatMap((item): CmsAiAttachment[] => {
    if (
      !isRecord(item) ||
      typeof item.key !== 'string' ||
      typeof item.fileName !== 'string' ||
      typeof item.bytes !== 'number' ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes <= 0 ||
      item.bytes > MAX_ATTACHMENT_BYTES ||
      (item.contentType !== 'image/jpeg' &&
        item.contentType !== 'image/png' &&
        item.contentType !== 'image/webp')
    ) {
      return []
    }

    return [
      {
        bytes: item.bytes,
        contentType: item.contentType,
        fileName: sanitizeFileName(item.fileName),
        key: item.key,
      },
    ]
  })
}

function parseChangedPaths(value: string) {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? normalizeChangedPaths(parsed) : []
}

function normalizeChangedPaths(value: unknown[]) {
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.replace(/\\/g, '/').replace(/^\/+/, ''))
        .filter(
          (item) =>
            item.length > 0 &&
            item.length <= 240 &&
            !item.includes('\u0000') &&
            !item
              .split('/')
              .some((part) => !part || part === '.' || part === '..'),
        ),
    ),
  ).slice(0, 50)
}

function normalizeGithubUrl(value: string | null | undefined) {
  const url = normalizeHttpsUrl(value)

  return url && new URL(url).hostname === 'github.com' ? url : null
}

function normalizeHttpsUrl(value: string | null | undefined) {
  if (!value) return null

  try {
    const url = new URL(value)

    return url.protocol === 'https:' && !url.username && !url.password
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function limitOptionalText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= maxLength ? normalized : null
}

function getTargetHostnames(env: CmsAiEnv) {
  const configured = String(env.CMS_AI_TARGET_HOSTNAMES || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)

  return configured.length > 0
    ? Array.from(new Set(configured))
    : DEFAULT_TARGET_HOSTNAMES
}

function sanitizeFileName(value: string) {
  const normalized = value
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)

  return normalized || 'reference-image'
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function asAscii(value: Uint8Array) {
  return String.fromCharCode(...value)
}
