import {
  assertSameOriginRequest,
  CmsAiError,
  createCmsAiJob,
  createJobId,
  dispatchCmsAiJob,
  getCmsAiJob,
  json,
  methodNotAllowed,
  normalizeInstruction,
  normalizeReasoningEffort,
  normalizeTargetUrl,
  toCmsAiErrorResponse,
  toPublicCmsAiJob,
  updateCmsAiJob,
  type CmsAiEnv,
} from '../_shared.ts'
import { getAccessIdentity } from '../../_access-auth.ts'

export const onRequest: PagesFunction<CmsAiEnv> = async ({ request, env }) => {
  const auth = await getAccessIdentity(request, env)

  if (!auth.ok) {
    return json({ message: auth.message }, auth.status)
  }

  const jobId = getJobId(request)
  const method = request.method.toUpperCase()

  try {
    if (method === 'POST' && !jobId) {
      assertSameOriginRequest(request)
      return await createJob(request, env, auth.email)
    }

    if (method === 'GET' && jobId) {
      const job = await getCmsAiJob(env, jobId, auth.email)

      if (!job) {
        return json({ message: 'CMS AIジョブが見つかりません。' }, 404)
      }

      return json({ job: toPublicCmsAiJob(job) })
    }

    if (method === 'GET' || method === 'POST') {
      return json({ message: 'CMS AIジョブのURLを確認してください。' }, 404)
    }

    return methodNotAllowed(['GET', 'POST'])
  } catch (error) {
    return toCmsAiErrorResponse(error, 'cms_ai_jobs_request_failed')
  }
}

async function createJob(request: Request, env: CmsAiEnv, requestedBy: string) {
  const form = await request.formData().catch(() => {
    throw new CmsAiError(400, '依頼内容を読み取れません。')
  })
  const targetUrl = normalizeTargetUrl(form.get('targetUrl'), env)
  const instruction = normalizeInstruction(form.get('instruction'))
  const reasoningEffort = normalizeReasoningEffort(form.get('reasoningEffort'))
  assertNoReferenceImage(form)
  const jobId = createJobId()
  const job = await createCmsAiJob(env, {
    attachments: [],
    id: jobId,
    instruction,
    reasoningEffort,
    requestedBy,
    targetUrl,
  })

  try {
    await dispatchCmsAiJob(env, job.id, job.conversationId)
  } catch (error) {
    const failed = await updateCmsAiJob(env, job.id, {
      errorMessage:
        'GitHub Actionsを開始できませんでした。時間をおいて再試行してください。',
      status: 'failed',
      summary: 'GitHub Actionsの起動に失敗しました。',
    })

    console.warn(
      JSON.stringify({
        event: 'cms_ai_dispatch_failed',
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    )

    return json({ job: toPublicCmsAiJob(failed) }, 202)
  }

  return json({ job: toPublicCmsAiJob(job) }, 202)
}

function assertNoReferenceImage(form: FormData) {
  const hasReferenceImage = form.getAll('referenceImage').some((value) => {
    if (typeof value === 'string') return value.trim().length > 0
    return Boolean(value.name) || value.size > 0
  })

  if (hasReferenceImage) {
    throw new CmsAiError(
      400,
      '現在のGLM-5.3は参考画像に対応していません。URLと文章で依頼してください。',
    )
  }
}

function getJobId(request: Request) {
  const prefix = '/admin/api/ai/jobs'
  const pathname = new URL(request.url).pathname

  if (pathname === prefix || pathname === prefix + '/') return null
  if (!pathname.startsWith(prefix + '/')) return null

  const value = pathname.slice(prefix.length + 1)
  return value && !value.includes('/') ? value : null
}
