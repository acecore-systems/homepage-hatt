import { getAccessIdentity } from '../../_access-auth.ts'
import {
  assertSameOriginRequest,
  CMS_AI_MAX_CONVERSATION_TURNS,
  CmsAiError,
  createCmsAiJob,
  createJobId,
  dispatchCmsAiJob,
  getCmsAiConversation,
  json,
  listCmsAiConversations,
  methodNotAllowed,
  normalizeInstruction,
  normalizeReasoningEffort,
  toCmsAiErrorResponse,
  toPublicCmsAiConversation,
  toPublicCmsAiConversationSummary,
  updateCmsAiJob,
  type CmsAiEnv,
} from '../_shared.ts'

export const onRequest: PagesFunction<CmsAiEnv> = async ({ request, env }) => {
  const auth = await getAccessIdentity(request, env)

  if (!auth.ok) {
    return json({ message: auth.message }, auth.status)
  }

  const route = getRoute(request)
  const method = request.method.toUpperCase()

  try {
    if (method === 'GET' && route.kind === 'list') {
      const conversations = await listCmsAiConversations(env, auth.email)

      return json({
        conversations: conversations
          .map(toPublicCmsAiConversationSummary)
          .filter((conversation) => conversation !== null),
      })
    }

    if (method === 'GET' && route.kind === 'conversation') {
      const jobs = await getCmsAiConversation(
        env,
        route.conversationId,
        auth.email,
      )
      const conversation = toPublicCmsAiConversation(jobs)

      return conversation
        ? json({ conversation })
        : json({ message: 'CMS AIの会話が見つかりません。' }, 404)
    }

    if (method === 'POST' && route.kind === 'messages') {
      assertSameOriginRequest(request)
      return await createFollowUp(
        request,
        env,
        auth.email,
        route.conversationId,
      )
    }

    if (route.kind === 'unknown') {
      return json({ message: 'CMS AIの会話URLを確認してください。' }, 404)
    }

    return methodNotAllowed(['GET', 'POST'])
  } catch (error) {
    return toCmsAiErrorResponse(error, 'cms_ai_conversations_request_failed')
  }
}

async function createFollowUp(
  request: Request,
  env: CmsAiEnv,
  requestedBy: string,
  conversationId: string,
) {
  const jobs = await getCmsAiConversation(env, conversationId, requestedBy)

  if (jobs.length === 0) {
    throw new CmsAiError(404, 'CMS AIの会話が見つかりません。')
  }

  const latest = jobs[jobs.length - 1]

  if (isPending(latest.status)) {
    throw new CmsAiError(
      409,
      'AIが前のメッセージを処理中です。完了後に続けてください。',
    )
  }

  if (latest.status === 'merged') {
    throw new CmsAiError(
      409,
      'この変更はマージ済みです。続きは新しい会話で依頼してください。',
    )
  }

  if (jobs.length >= CMS_AI_MAX_CONVERSATION_TURNS) {
    throw new CmsAiError(
      409,
      'この会話は上限に達しました。新しい会話を開始してください。',
    )
  }

  const form = await request.formData().catch(() => {
    throw new CmsAiError(400, 'メッセージを読み取れません。')
  })
  const instruction = normalizeInstruction(form.get('instruction'))
  const reasoningEffort = normalizeReasoningEffort(
    form.get('reasoningEffort') || latest.reasoningEffort,
  )
  const prUrl = [...jobs].reverse().find((job) => Boolean(job.prUrl))?.prUrl
  let job: Awaited<ReturnType<typeof createCmsAiJob>>

  try {
    job = await createCmsAiJob(env, {
      attachments: [],
      branchName: latest.branchName,
      conversationId,
      id: createJobId(),
      instruction,
      prUrl: prUrl || null,
      reasoningEffort,
      requestedBy,
      targetUrl: jobs[0].targetUrl,
      turnNumber: latest.turnNumber + 1,
    })
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('cms_ai_jobs.conversation_id') &&
      error.message.includes('cms_ai_jobs.turn_number')
    ) {
      throw new CmsAiError(
        409,
        '前のメッセージがすでに受け付けられています。会話を再読み込みしてください。',
      )
    }

    throw error
  }

  try {
    await dispatchCmsAiJob(env, job.id, conversationId)
  } catch (error) {
    const failed = await updateCmsAiJob(env, job.id, {
      errorMessage:
        'GitHub Actionsを開始できませんでした。時間をおいて再試行してください。',
      status: 'failed',
      summary: 'GitHub Actionsの起動に失敗しました。',
    })

    console.warn(
      JSON.stringify({
        event: 'cms_ai_follow_up_dispatch_failed',
        conversationId,
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    )

    return json(
      {
        conversation: toPublicCmsAiConversation([...jobs, failed]),
      },
      202,
    )
  }

  return json(
    {
      conversation: toPublicCmsAiConversation([...jobs, job]),
    },
    202,
  )
}

function isPending(status: string) {
  return status === 'queued' || status === 'running' || status === 'validating'
}

function getRoute(request: Request) {
  const prefix = '/admin/api/ai/conversations'
  const pathname = new URL(request.url).pathname

  if (pathname === prefix || pathname === prefix + '/') {
    return { kind: 'list' as const }
  }

  if (!pathname.startsWith(prefix + '/')) {
    return { kind: 'unknown' as const }
  }

  const parts = pathname
    .slice(prefix.length + 1)
    .split('/')
    .filter(Boolean)

  if (parts.length === 1) {
    return { conversationId: parts[0], kind: 'conversation' as const }
  }

  if (parts.length === 2 && parts[1] === 'messages') {
    return { conversationId: parts[0], kind: 'messages' as const }
  }

  return { kind: 'unknown' as const }
}
