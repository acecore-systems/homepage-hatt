import {
  countMeaningfulCharacters,
  getClientIp,
  isAllowedRequestOrigin,
  jsonResponse,
  normalizeText,
  optionsResponse,
  parseEmailAddress,
  parseEmailAddresses,
  readJsonPayload,
  sendTransactionalEmail,
  verifyTurnstile,
  type FormEnv,
} from '../../_form-shared.ts'

type ContactEnv = FormEnv & {
  SHOP_CONTACT_EMAIL_TO?: string
  SHOP_CONTACT_EMAIL_FROM?: string
  COURSE_SIGNUP_EMAIL_TO?: string
  COURSE_SIGNUP_EMAIL_FROM?: string
}

type ContactContext = {
  request: Request
  env: ContactEnv
}

type ContactPayload = {
  name?: unknown
  email?: unknown
  category?: unknown
  orderNumber?: unknown
  message?: unknown
  consent?: unknown
  turnstileToken?: unknown
  website?: unknown
}

type ContactCategory = 'order' | 'download' | 'refund' | 'product' | 'other'

type ValidContact = {
  name: string
  email: string
  category: ContactCategory
  orderNumber: string
  message: string
  turnstileToken: string
}

const CATEGORY_LABELS: Record<ContactCategory, string> = {
  order: '注文について',
  download: 'ダウンロードについて',
  refund: '返品・返金について',
  product: '商品について',
  other: 'その他',
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_MESSAGE_LENGTH = 10

export const onRequestPost = async ({
  request,
  env,
}: ContactContext): Promise<Response> => {
  if (!isAllowedRequestOrigin(request, env)) {
    return jsonResponse(
      { ok: false, message: 'お問い合わせを送信できませんでした。' },
      403,
    )
  }

  const payload = await readJsonPayload<ContactPayload>(request)
  const validation = validateContactPayload(payload)

  if (!validation.ok) {
    return jsonResponse({ ok: false, message: validation.message }, 400)
  }

  const turnstileValid = await verifyTurnstile(
    request,
    env,
    validation.contact.turnstileToken,
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

  try {
    await sendContactEmail(request, env, validation.contact)
    return jsonResponse(
      {
        ok: true,
        message: 'お問い合わせを受け付けました。',
      },
      201,
    )
  } catch (error) {
    console.error('Failed to send shop contact email:', error)
    return jsonResponse(
      { ok: false, message: 'お問い合わせを送信できませんでした。' },
      500,
    )
  }
}

export const onRequestOptions = ({ request, env }: ContactContext): Response =>
  optionsResponse(request, env)

export const onRequestGet = (): Response =>
  new Response(null, {
    status: 405,
    headers: { Allow: 'POST, OPTIONS' },
  })

export function validateContactPayload(
  payload: ContactPayload | null,
): { ok: true; contact: ValidContact } | { ok: false; message: string } {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: '入力内容を確認してください。' }
  }

  if (String(payload.website || '').trim()) {
    return { ok: false, message: '入力内容を確認してください。' }
  }

  const name = normalizeText(payload.name, 60)
  const email = normalizeText(payload.email, 254)
  const category = normalizeText(payload.category, 20) as ContactCategory
  const orderNumber = normalizeText(payload.orderNumber, 120)
  const message = normalizeText(payload.message, 2000, true)
  const turnstileToken = String(payload.turnstileToken || '').trim()

  if (
    !name ||
    !email ||
    !category ||
    !message ||
    !turnstileToken ||
    payload.consent !== true
  ) {
    return { ok: false, message: '必須項目を入力してください。' }
  }

  if (
    countMeaningfulCharacters(name) < 1 ||
    !EMAIL_PATTERN.test(email) ||
    !(category in CATEGORY_LABELS) ||
    countMeaningfulCharacters(message) < MIN_MESSAGE_LENGTH ||
    turnstileToken.length > 2048
  ) {
    return { ok: false, message: '入力内容を確認してください。' }
  }

  return {
    ok: true,
    contact: {
      name,
      email,
      category,
      orderNumber,
      message,
      turnstileToken,
    },
  }
}

async function sendContactEmail(
  request: Request,
  env: ContactEnv,
  contact: ValidContact,
): Promise<string> {
  const from = parseEmailAddress(
    env.SHOP_CONTACT_EMAIL_FROM || env.COURSE_SIGNUP_EMAIL_FROM,
  )
  const to = parseEmailAddresses(
    env.SHOP_CONTACT_EMAIL_TO || env.COURSE_SIGNUP_EMAIL_TO,
  )

  if (!from || to.length === 0) {
    throw new Error('Shop contact email is not configured')
  }

  return sendTransactionalEmail(env, {
    from,
    to,
    replyTo: contact.email,
    subject: `【Hatt shop】${CATEGORY_LABELS[contact.category]}: ${contact.name}`,
    text: buildContactEmailText(request, contact),
  })
}

function buildContactEmailText(
  request: Request,
  contact: ValidContact,
): string {
  const requestUrl = new URL(request.url)

  return [
    'Hatt shopへのお問い合わせが届きました。',
    '',
    `名前: ${contact.name}`,
    `メールアドレス: ${contact.email}`,
    `種別: ${CATEGORY_LABELS[contact.category]}`,
    `注文番号: ${contact.orderNumber || '未入力'}`,
    '',
    'お問い合わせ内容:',
    contact.message,
    '',
    `受付日時: ${new Date().toISOString()}`,
    `送信元ページ: ${requestUrl.origin}/shop/contact/`,
    `送信元IP: ${getClientIp(request) || 'unknown'}`,
  ].join('\n')
}
