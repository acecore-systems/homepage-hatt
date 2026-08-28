import {
  assertReferenceImageSignature,
  assertSameOriginRequest,
  CmsAiError,
  createAttachmentKey,
  createCmsAiJob,
  createJobId,
  deleteCmsAiJob,
  dispatchCmsAiJob,
  getCmsAiAssets,
  getCmsAiJob,
  json,
  methodNotAllowed,
  normalizeInstruction,
  normalizeTargetUrl,
  toCmsAiErrorResponse,
  toPublicCmsAiJob,
  updateCmsAiJob,
  validateReferenceImage,
  type CmsAiAttachment,
  type CmsAiEnv,
} from '../_shared.ts'
import { getAccessIdentity } from '../../_access-auth.ts'

type UploadedReferenceImage = {
  arrayBuffer(): Promise<ArrayBuffer>
  name?: string
  size?: number
  type?: string
}

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
  const jobId = createJobId()
  const reference = await readReferenceImage(form, jobId)
  const attachments = reference ? [reference.attachment] : []
  const job = await createCmsAiJob(env, {
    attachments,
    id: jobId,
    instruction,
    requestedBy,
    targetUrl,
  })

  try {
    if (reference) {
      await getCmsAiAssets(env).put(reference.attachment.key, reference.bytes, {
        customMetadata: {
          job_id: job.id,
          kind: 'reference-image',
        },
        httpMetadata: {
          cacheControl: 'private, no-store',
          contentType: reference.attachment.contentType,
        },
      })
    }
  } catch (error) {
    await deleteCmsAiJob(env, job.id).catch(() => undefined)
    throw error
  }

  try {
    await dispatchCmsAiJob(env, job.id)
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

async function readReferenceImage(form: FormData, jobId: string) {
  const values = form.getAll('referenceImage').flatMap((value) => {
    const file = asUploadedReferenceImage(value)

    if (!file || (!file.name && Number(file.size) === 0)) return []

    return [file]
  })

  if (values.length > 1) {
    throw new CmsAiError(
      400,
      '参考画像は1件まで添付できます。画像を並べた1枚の資料にしてください。',
    )
  }

  const file = values[0]

  if (!file) return null

  const { contentType, fileName } = validateReferenceImage(file)
  const bytes = await file.arrayBuffer()
  await assertReferenceImageSignature(bytes, contentType)
  const attachment: CmsAiAttachment = {
    bytes: bytes.byteLength,
    contentType,
    fileName,
    key: createAttachmentKey(jobId, contentType),
  }

  return { attachment, bytes }
}

function asUploadedReferenceImage(
  value: unknown,
): UploadedReferenceImage | null {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as UploadedReferenceImage).arrayBuffer !== 'function'
  ) {
    return null
  }

  return value as UploadedReferenceImage
}

function getJobId(request: Request) {
  const prefix = '/admin/api/ai/jobs'
  const pathname = new URL(request.url).pathname

  if (pathname === prefix || pathname === prefix + '/') return null
  if (!pathname.startsWith(prefix + '/')) return null

  const value = pathname.slice(prefix.length + 1)
  return value && !value.includes('/') ? value : null
}
