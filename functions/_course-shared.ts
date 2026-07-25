import {
  getClientIp,
  parseEmailAddress,
  parseEmailAddresses,
  sendTransactionalEmail,
  type FormEnv,
} from './_form-shared.ts'

export {
  countMeaningfulCharacters,
  isAllowedRequestOrigin,
  jsonResponse,
  normalizeText,
  optionsResponse,
  readJsonPayload,
  verifyTurnstile,
} from './_form-shared.ts'

export type Env = FormEnv & {
  COURSE_SIGNUP_EMAIL_TO?: string
  COURSE_SIGNUP_EMAIL_FROM?: string
}

export type PagesContext = {
  request: Request
  env: Env
  waitUntil(promise: Promise<unknown>): void
}

export type CourseSignup = {
  id: string
  name: string
  contact: string
  goal: string
  preferredTime: string
  createdAt: string
}

export async function sendCourseSignupEmail(
  request: Request,
  env: Env,
  signup: CourseSignup,
): Promise<string> {
  const from = parseEmailAddress(env.COURSE_SIGNUP_EMAIL_FROM)
  const to = parseEmailAddresses(env.COURSE_SIGNUP_EMAIL_TO)

  if (!from || to.length === 0) {
    throw new Error('Course signup email is not configured')
  }

  const replyTo = extractReplyTo(signup.contact)

  return sendTransactionalEmail(env, {
    from,
    to,
    subject: `【Hatt講座】無料体験申し込み: ${signup.name}`,
    text: buildCourseSignupEmailText(request, signup),
    ...(replyTo ? { replyTo } : {}),
  })
}

export function toPublicSignup(signup: CourseSignup) {
  return {
    id: signup.id,
    name: signup.name,
    contact: signup.contact,
    goal: signup.goal,
    preferredTime: signup.preferredTime,
    createdAt: signup.createdAt,
  }
}

function buildCourseSignupEmailText(
  request: Request,
  signup: CourseSignup,
): string {
  const requestUrl = new URL(request.url)
  const clientIp = getClientIp(request) || 'unknown'

  return [
    'モデル制作講座の無料体験申し込みが届きました。',
    '',
    `名前: ${signup.name}`,
    `連絡先: ${signup.contact}`,
    `希望日時: ${signup.preferredTime}`,
    '',
    '作りたいもの・相談したいこと:',
    signup.goal,
    '',
    `受付日時: ${signup.createdAt}`,
    `送信元ページ: ${requestUrl.origin}/modeling-course/`,
    `送信元IP: ${clientIp}`,
  ].join('\n')
}

function extractReplyTo(contact: string): string | undefined {
  const match = contact.match(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i)
  return match?.[0]
}
