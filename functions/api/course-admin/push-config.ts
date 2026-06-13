import {
  isAllowedRequestOrigin,
  jsonResponse,
  optionsResponse,
  verifyAdminRequest,
  type PagesContext,
} from '../../_course-shared'

export const onRequestGet = async (
  context: PagesContext,
): Promise<Response> => {
  if (!isAllowedRequestOrigin(context.request, context.env)) {
    return jsonResponse({ ok: false, message: 'アクセスできません。' }, 403)
  }

  const auth = await verifyAdminRequest(context.request, context.env)
  if (!auth.ok) return auth.response

  const publicKey = context.env.COURSE_VAPID_PUBLIC_KEY?.trim()
  if (!publicKey) {
    return jsonResponse(
      { ok: false, message: '通知用の公開キーが設定されていません。' },
      503,
    )
  }

  return jsonResponse({ ok: true, publicKey })
}

export const onRequestOptions = (context: PagesContext): Response =>
  optionsResponse(context.request, context.env)
