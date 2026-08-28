import { getGitHubActionsIdentity } from '../_github-actions-auth.ts'
import {
  CmsAiError,
  getCmsAiJob,
  isAutoMergeEnabled,
  isCmsAiJobStatus,
  json,
  methodNotAllowed,
  toCmsAiErrorResponse,
  updateCmsAiJob,
  type CmsAiEnv,
} from '../_shared.ts'
import { runCmsAiInference, validateSourceFiles } from '../_runner.ts'

export const onRequest: PagesFunction<CmsAiEnv> = async ({ request, env }) => {
  try {
    await getGitHubActionsIdentity(request, env)
    const route = getRoute(request)

    if (request.method === 'GET' && route.kind === 'job') {
      return await getJob(env, route.jobId)
    }

    if (request.method === 'POST' && route.kind === 'inference') {
      return await runInference(request, env)
    }

    if (request.method === 'POST' && route.kind === 'status') {
      return await updateStatus(request, env, route.jobId)
    }

    if (route.kind === 'unknown') {
      return json({ message: 'CMS AI runnerのURLを確認してください。' }, 404)
    }

    return methodNotAllowed(['GET', 'POST'])
  } catch (error) {
    return toCmsAiErrorResponse(error, 'cms_ai_runner_request_failed')
  }
}

async function getJob(env: CmsAiEnv, jobId: string) {
  const job = await getCmsAiJob(env, jobId)

  if (!job) {
    return json({ message: 'CMS AIジョブが見つかりません。' }, 404)
  }

  return json({
    job: {
      attachmentCount: job.attachments.length,
      autoMergeEnabled: isAutoMergeEnabled(env),
      branchName: job.branchName,
      id: job.id,
      instruction: job.instruction,
      status: job.status,
      targetUrl: job.targetUrl,
    },
  })
}

async function runInference(request: Request, env: CmsAiEnv) {
  const body = await readJson(request)
  const jobId = requiredText(body.jobId, 64)
  const job = await getCmsAiJob(env, jobId)

  if (!job) {
    throw new CmsAiError(404, 'CMS AIジョブが見つかりません。')
  }

  if (
    job.status !== 'queued' &&
    job.status !== 'running' &&
    job.status !== 'validating'
  ) {
    throw new CmsAiError(409, 'このCMS AIジョブは実行できません。')
  }

  const validationFeedback = optionalText(body.validationFeedback, 12_000)
  const sourceFiles = validateSourceFiles(body.files)
  await updateCmsAiJob(env, job.id, {
    errorMessage: null,
    status: 'running',
    summary: 'AIが変更案を作成しています。',
  })
  const result = await runCmsAiInference(
    env,
    job,
    sourceFiles,
    validationFeedback || undefined,
  )

  if (result.changes.length === 0) {
    const waiting = await updateCmsAiJob(env, job.id, {
      clarification:
        result.clarification ||
        '変更を確定するために、依頼内容をもう少し具体的にしてください。',
      status: 'needs_input',
      summary: result.summary,
    })

    return json({ result, status: waiting.status })
  }

  return json({ result, status: 'running' })
}

async function updateStatus(request: Request, env: CmsAiEnv, jobId: string) {
  const body = await readJson(request)

  if (!isCmsAiJobStatus(body.status) || body.status === 'queued') {
    throw new CmsAiError(400, 'CMS AIジョブの状態を確認してください。')
  }

  const update: Parameters<typeof updateCmsAiJob>[2] = {
    status: body.status,
  }

  if ('changedPaths' in body) {
    update.changedPaths = Array.isArray(body.changedPaths)
      ? body.changedPaths
      : []
  }
  if ('clarification' in body) {
    update.clarification = optionalText(body.clarification, 4_000)
  }
  if ('deploymentUrl' in body) {
    update.deploymentUrl = optionalText(body.deploymentUrl, 2_000)
  }
  if ('errorMessage' in body) {
    update.errorMessage = optionalText(body.errorMessage, 2_000)
  }
  if ('prUrl' in body) {
    update.prUrl = optionalText(body.prUrl, 2_000)
  }
  if ('summary' in body) {
    update.summary = optionalText(body.summary, 4_000)
  }

  const updated = await updateCmsAiJob(env, jobId, update)

  return json({ job: { id: updated.id, status: updated.status } })
}

async function readJson(request: Request) {
  const body = await request.json().catch(() => null)

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CmsAiError(400, 'CMS AI runnerの入力を確認してください。')
  }

  return body as Record<string, unknown>
}

function requiredText(value: unknown, maxLength: number) {
  const text = optionalText(value, maxLength)

  if (!text) {
    throw new CmsAiError(400, 'CMS AI runnerの入力を確認してください。')
  }

  return text
}

function optionalText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return null
  const text = value.trim()

  return text && text.length <= maxLength ? text : null
}

function getRoute(request: Request) {
  const prefix = '/admin/api/ai/runner/'
  const pathname = new URL(request.url).pathname

  if (!pathname.startsWith(prefix)) return { kind: 'unknown' as const }

  const parts = pathname.slice(prefix.length).split('/').filter(Boolean)

  if (parts.length === 2 && parts[0] === 'jobs') {
    return { jobId: parts[1], kind: 'job' as const }
  }

  if (parts.length === 1 && parts[0] === 'inference') {
    return { kind: 'inference' as const }
  }

  if (parts.length === 3 && parts[0] === 'jobs' && parts[2] === 'status') {
    return { jobId: parts[1], kind: 'status' as const }
  }

  return { kind: 'unknown' as const }
}
