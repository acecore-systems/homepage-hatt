import {
  adminSessionCookie,
  assertSameOriginRequest,
  createAdminSession,
  handleApiError,
  jsonResponse,
  methodNotAllowed,
  readJson,
  type PagesContext,
  verifyAdminPassword,
} from '../_shared'

type LoginPayload = {
  password?: unknown
}

export const onRequestPost = async ({ request, env }: PagesContext) => {
  try {
    assertSameOriginRequest(request)
    const payload = await readJson<LoginPayload>(request)
    const password = String(payload.password || '')

    if (!(await verifyAdminPassword(password, env))) {
      return jsonResponse(
        { ok: false, message: 'パスワードを確認してください。' },
        401,
      )
    }

    const token = await createAdminSession(env)
    return jsonResponse({ ok: true }, 200, {
      'Set-Cookie': adminSessionCookie(token),
    })
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestGet = () => methodNotAllowed(['POST'])
