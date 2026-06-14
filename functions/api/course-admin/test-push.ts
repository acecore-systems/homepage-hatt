import {
  isAllowedRequestOrigin,
  jsonResponse,
  optionsResponse,
  sendTestCourseNotification,
  verifyAdminRequest,
  type PagesContext,
} from '../../_course-shared'

export const onRequestPost = async (
  context: PagesContext,
): Promise<Response> => {
  if (!isAllowedRequestOrigin(context.request, context.env)) {
    return jsonResponse({ ok: false, message: 'アクセスできません。' }, 403)
  }

  const auth = await verifyAdminRequest(context.request, context.env)
  if (!auth.ok) return auth.response

  try {
    const sent = await sendTestCourseNotification(context.env)
    return jsonResponse({
      ok: true,
      message:
        sent > 0
          ? `テスト通知を${sent}件送信しました。`
          : '有効な通知登録がありません。',
      sent,
    })
  } catch (error) {
    console.error('Failed to send course test push:', error)
    return jsonResponse(
      { ok: false, message: 'テスト通知を送信できません。' },
      500,
    )
  }
}

export const onRequestOptions = (context: PagesContext): Response =>
  optionsResponse(context.request, context.env)
