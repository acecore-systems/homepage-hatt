import {
  handleApiError,
  jsonResponse,
  methodNotAllowed,
  requireAdmin,
  type PagesContext,
} from '../_shared'

export const onRequestGet = async ({ request, env }: PagesContext) => {
  try {
    const identity = await requireAdmin(request, env)
    return jsonResponse({ ok: true, email: identity.email })
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestPost = () => methodNotAllowed(['GET'])
