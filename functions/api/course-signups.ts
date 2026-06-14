import {
  countMeaningfulCharacters,
  getClientHashes,
  hasRequiredHashSalt,
  isAllowedRequestOrigin,
  jsonResponse,
  normalizeText,
  notifyCourseAdmins,
  optionsResponse,
  readJsonPayload,
  toPublicSignup,
  verifyTurnstile,
  type CourseSignupRow,
  type PagesContext,
} from '../_course-shared'

type SignupPayload = {
  name?: unknown
  contact?: unknown
  goal?: unknown
  preferredTime?: unknown
  consent?: unknown
  turnstileToken?: unknown
  website?: unknown
}

type SignupValidation =
  | {
      ok: true
      name: string
      contact: string
      goal: string
      preferredTime: string
      turnstileToken: string
    }
  | { ok: false; message: string }

const SIGNUP_RATE_WINDOW_MS = 60 * 60 * 1000
const SIGNUP_RATE_MAX_REQUESTS = 3

export const onRequestPost = async (
  context: PagesContext,
): Promise<Response> => {
  if (!isAllowedRequestOrigin(context.request, context.env)) {
    return jsonResponse(
      { ok: false, message: '申し込みを送信できませんでした。' },
      403,
    )
  }

  if (!context.env.COMMENTS_DB) {
    return jsonResponse(
      { ok: false, message: '申し込み機能を一時的に利用できません。' },
      503,
    )
  }

  if (!hasRequiredHashSalt(context.request, context.env)) {
    return jsonResponse(
      { ok: false, message: '申し込み機能を一時的に利用できません。' },
      503,
    )
  }

  const payload = await readJsonPayload<SignupPayload>(context.request)
  const validation = validateSignupPayload(payload)

  if (!validation.ok) {
    return jsonResponse({ ok: false, message: validation.message }, 400)
  }

  const turnstileValid = await verifyTurnstile(
    context.request,
    context.env,
    validation.turnstileToken,
  )

  if (!turnstileValid) {
    return jsonResponse(
      {
        ok: false,
        message: '送信前の確認に失敗しました。もう一度お試しください。',
      },
      403,
    )
  }

  const now = new Date()
  const { clientHash, userAgentHash } = await getClientHashes(
    context.request,
    context.env,
  )

  try {
    const recent = await context.env.COMMENTS_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM course_trial_signups
       WHERE client_hash = ? AND created_at >= ?`,
    )
      .bind(
        clientHash,
        new Date(now.getTime() - SIGNUP_RATE_WINDOW_MS).toISOString(),
      )
      .first<{ count: number }>()

    if (Number(recent?.count || 0) >= SIGNUP_RATE_MAX_REQUESTS) {
      return jsonResponse(
        {
          ok: false,
          message:
            '短時間に送信できる回数を超えました。少し待ってからお試しください。',
        },
        429,
        { 'Retry-After': String(60 * 60) },
      )
    }

    const row: CourseSignupRow = {
      id: crypto.randomUUID(),
      name: validation.name,
      contact: validation.contact,
      goal: validation.goal,
      preferred_time: validation.preferredTime,
      status: 'new',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }

    await context.env.COMMENTS_DB.prepare(
      `INSERT INTO course_trial_signups (
         id, name, contact, goal, preferred_time, status,
         client_hash, user_agent_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.name,
        row.contact,
        row.goal,
        row.preferred_time,
        row.status,
        clientHash,
        userAgentHash,
        row.created_at,
        row.updated_at,
      )
      .run()

    context.waitUntil(notifyCourseAdmins(context.env, row.id))

    return jsonResponse(
      {
        ok: true,
        message: '無料体験の申し込みを受け付けました。',
        signup: toPublicSignup(row),
      },
      201,
    )
  } catch (error) {
    console.error('Failed to create course signup:', error)
    return jsonResponse(
      { ok: false, message: '申し込みを送信できませんでした。' },
      500,
    )
  }
}

export const onRequestOptions = (context: PagesContext): Response =>
  optionsResponse(context.request, context.env)

function validateSignupPayload(
  payload: SignupPayload | null,
): SignupValidation {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: '入力内容を確認してください。' }
  }

  if (String(payload.website || '').trim()) {
    return { ok: false, message: '入力内容を確認してください。' }
  }

  const name = normalizeText(payload.name, 40)
  const contact = normalizeText(payload.contact, 140)
  const goal = normalizeText(payload.goal, 800, true)
  const preferredTime = normalizeText(payload.preferredTime, 160, true)
  const turnstileToken = String(payload.turnstileToken || '').trim()

  if (
    !name ||
    !contact ||
    !goal ||
    !preferredTime ||
    !turnstileToken ||
    payload.consent !== true
  ) {
    return { ok: false, message: '必須項目を入力してください。' }
  }

  if (
    countMeaningfulCharacters(name) < 1 ||
    countMeaningfulCharacters(contact) < 3 ||
    countMeaningfulCharacters(goal) < 8 ||
    countMeaningfulCharacters(preferredTime) < 2 ||
    turnstileToken.length > 2048
  ) {
    return { ok: false, message: '入力内容を確認してください。' }
  }

  return { ok: true, name, contact, goal, preferredTime, turnstileToken }
}
