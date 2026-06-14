import {
  isAllowedRequestOrigin,
  jsonResponse,
  optionsResponse,
  toPublicSignup,
  verifyAdminRequest,
  type CourseSignupRow,
  type PagesContext,
} from '../../_course-shared'

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

export const onRequestGet = async (
  context: PagesContext,
): Promise<Response> => {
  if (!isAllowedRequestOrigin(context.request, context.env)) {
    return jsonResponse({ ok: false, message: 'アクセスできません。' }, 403)
  }

  const auth = await verifyAdminRequest(context.request, context.env)
  if (!auth.ok) return auth.response

  if (!context.env.COMMENTS_DB) {
    return jsonResponse(
      { ok: false, message: '申し込みデータを読み込めません。' },
      503,
    )
  }

  const url = new URL(context.request.url)
  const limit = normalizeLimit(url.searchParams.get('limit'))

  try {
    const rows = await context.env.COMMENTS_DB.prepare(
      `SELECT id, name, contact, goal, preferred_time, status, created_at, updated_at
       FROM course_trial_signups
       ORDER BY created_at DESC
       LIMIT ?`,
    )
      .bind(limit)
      .all<CourseSignupRow>()

    return jsonResponse({
      ok: true,
      signups: (rows.results ?? []).map(toPublicSignup),
    })
  } catch (error) {
    console.error('Failed to load course signups:', error)
    return jsonResponse(
      { ok: false, message: '申し込みデータを読み込めません。' },
      500,
    )
  }
}

export const onRequestOptions = (context: PagesContext): Response =>
  optionsResponse(context.request, context.env)

function normalizeLimit(value: unknown): number {
  const limit = Number(value || DEFAULT_LIMIT)

  if (!Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT)
}
