import {
  countMeaningfulCharacters,
  isAllowedRequestOrigin,
  jsonResponse,
  normalizeText,
  optionsResponse,
  readJsonPayload,
  sendCourseSignupEmail,
  toPublicSignup,
  verifyTurnstile,
  type CourseSignup,
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

const MIN_GOAL_MEANINGFUL_LENGTH = 10

export const onRequestPost = async (
  context: PagesContext,
): Promise<Response> => {
  if (!isAllowedRequestOrigin(context.request, context.env)) {
    return jsonResponse(
      { ok: false, message: '申し込みを送信できませんでした。' },
      403,
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

  const signup: CourseSignup = {
    id: crypto.randomUUID(),
    name: validation.name,
    contact: validation.contact,
    goal: validation.goal,
    preferredTime: validation.preferredTime,
    createdAt: new Date().toISOString(),
  }

  try {
    await sendCourseSignupEmail(context.request, context.env, signup)

    return jsonResponse(
      {
        ok: true,
        message: '無料体験の申し込みを受け付けました。',
        signup: toPublicSignup(signup),
      },
      201,
    )
  } catch (error) {
    console.error('Failed to send course signup email:', error)
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
    countMeaningfulCharacters(goal) < MIN_GOAL_MEANINGFUL_LENGTH ||
    countMeaningfulCharacters(preferredTime) < 2 ||
    turnstileToken.length > 2048
  ) {
    return { ok: false, message: '入力内容を確認してください。' }
  }

  return { ok: true, name, contact, goal, preferredTime, turnstileToken }
}
