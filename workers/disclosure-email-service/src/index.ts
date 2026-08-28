type PublicSellerProfile = {
  profileVersion: string
  businessName: string
  sellerName: string
  phone: string
}

type PrivateSellerProfile = PublicSellerProfile & {
  version: 1
  address: string
}

type DisclosureEmailEnv = {
  EMAIL?: {
    send(message: {
      from: { email: string; name: string }
      to: string
      subject: string
      text: string
      headers: Record<string, string>
    }): Promise<{ messageId?: string }>
  }
  DISCLOSURE_FROM_ADDRESS?: string
  DISCLOSURE_LEGAL_DETAILS_JSON?: string
  DISCLOSURE_SERVICE_TOKEN?: string
}

const READY_PATH = '/v1/ready'
const DISCLOSURES_PATH = '/v1/disclosures'
const MAX_BODY_BYTES = 4_096
const MAX_MESSAGE_ID_LENGTH = 500
const PROFILE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const worker: ExportedHandler<DisclosureEmailEnv> = {
  async fetch(request, env): Promise<Response> {
    try {
      if (!(await isAuthorized(request, env))) {
        console.warn(
          JSON.stringify({ event: 'seller_disclosure_email_unauthorized' }),
        )
        return json({ ok: false }, 401)
      }

      const url = new URL(request.url)
      if (request.method !== 'POST') return json({ ok: false }, 405)
      if (!isJsonRequest(request)) return json({ ok: false }, 415)

      const body = await readJson(request)
      if (url.pathname === READY_PATH) {
        const profile = parsePublicSellerProfile(body)
        const details = getPrivateSellerProfile(env)
        const profilesMatch =
          profile !== null &&
          details !== null &&
          samePublicSellerProfile(profile, details)
        if (!profilesMatch) {
          console.warn(
            JSON.stringify({
              event: 'seller_disclosure_email_not_ready',
              hasPublicProfile: profile !== null,
              hasPrivateProfile: details !== null,
              profilesMatch,
            }),
          )
          return json({ ok: false }, 503)
        }
        return json({ ok: true })
      }

      if (url.pathname !== DISCLOSURES_PATH) return json({ ok: false }, 404)
      const requestData = parseDisclosureEmailRequest(body)
      const details = getPrivateSellerProfile(env)
      const from = validEmail(env.DISCLOSURE_FROM_ADDRESS)
      if (
        !requestData ||
        !details ||
        !from ||
        !env.EMAIL ||
        !samePublicSellerProfile(requestData, details)
      ) {
        return json({ ok: false }, 503)
      }

      const result = await env.EMAIL.send({
        from: { email: from, name: 'Hatt shop' },
        to: requestData.recipientEmail,
        subject: '【Hatt shop】販売者情報の開示',
        text: buildDisclosureEmail(details, requestData.requestId),
        headers: {
          'X-Hatt-Disclosure-Request-ID': requestData.requestId,
        },
      })
      const messageId = normalizedText(result.messageId, MAX_MESSAGE_ID_LENGTH)
      return messageId
        ? json({ ok: true, messageId })
        : json({ ok: false }, 503)
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'seller_disclosure_email_failed',
          error: error instanceof Error ? error.name : 'unknown',
        }),
      )
      return json({ ok: false }, 503)
    }
  },
}

export default worker

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

async function isAuthorized(request: Request, env: DisclosureEmailEnv) {
  const expected = normalizedText(env.DISCLOSURE_SERVICE_TOKEN, 500)
  const supplied = request.headers.get('Authorization') || ''
  if (!expected) return false

  const [expectedHash, suppliedHash] = await Promise.all([
    sha256(`Bearer ${expected}`),
    sha256(supplied),
  ])
  return timingSafeEqual(expectedHash, suppliedHash)
}

function isJsonRequest(request: Request) {
  return (
    request.headers.get('Content-Type')?.split(';')[0].trim() ===
    'application/json'
  )
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get('Content-Length') || 0)
  if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) {
    throw new RangeError('request body is too large')
  }

  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new RangeError('request body is too large')
  }
  return JSON.parse(raw) as unknown
}

function parseDisclosureEmailRequest(value: unknown) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'requestId',
      'recipientEmail',
      'profileVersion',
      'businessName',
      'sellerName',
      'phone',
    ])
  ) {
    return null
  }

  const profile = parsePublicSellerProfile({
    profileVersion: value.profileVersion,
    businessName: value.businessName,
    sellerName: value.sellerName,
    phone: value.phone,
  })
  const requestId = normalizedText(value.requestId, 64)
  const recipientEmail = normalizedEmail(value.recipientEmail)
  if (
    !profile ||
    !requestId ||
    !UUID_PATTERN.test(requestId) ||
    !recipientEmail
  ) {
    return null
  }

  return { ...profile, requestId, recipientEmail }
}

function parsePublicSellerProfile(value: unknown): PublicSellerProfile | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'profileVersion',
      'businessName',
      'sellerName',
      'phone',
    ])
  ) {
    return null
  }

  const profileVersion = normalizedText(value.profileVersion, 64)
  const businessName = normalizedText(value.businessName, 200)
  const sellerName = normalizedText(value.sellerName, 200)
  const phone = normalizedText(value.phone, 80)
  if (
    !profileVersion ||
    !PROFILE_VERSION_PATTERN.test(profileVersion) ||
    !businessName ||
    !sellerName ||
    !phone
  ) {
    return null
  }

  return { profileVersion, businessName, sellerName, phone }
}

function getPrivateSellerProfile(
  env: DisclosureEmailEnv,
): PrivateSellerProfile | null {
  try {
    const value = JSON.parse(
      String(env.DISCLOSURE_LEGAL_DETAILS_JSON || ''),
    ) as unknown
    if (!isRecord(value) || value.version !== 1) return null

    const profile = parsePublicSellerProfile({
      profileVersion: value.profileVersion,
      businessName: value.businessName,
      sellerName: value.sellerName,
      phone: value.phone,
    })
    const address = normalizedText(value.address, 500)
    return profile && address ? { version: 1, ...profile, address } : null
  } catch {
    return null
  }
}

function samePublicSellerProfile(
  expected: PublicSellerProfile,
  actual: PublicSellerProfile,
) {
  return (
    expected.profileVersion === actual.profileVersion &&
    expected.businessName === actual.businessName &&
    expected.sellerName === actual.sellerName &&
    expected.phone === actual.phone
  )
}

function buildDisclosureEmail(
  profile: PrivateSellerProfile,
  requestId: string,
) {
  return [
    'Hatt shop 販売者情報の開示をご請求いただき、ありがとうございます。',
    '',
    '特定商取引法に基づく販売者情報は次のとおりです。',
    '',
    `販売業者: ${profile.businessName}`,
    `販売責任者: ${profile.sellerName}`,
    `所在地: ${profile.address}`,
    `電話番号: ${profile.phone}`,
    '',
    `受付番号: ${requestId}`,
    '',
    'このメールは開示請求を受け付けた方へ自動送信しています。',
    'このメールへの返信は受け付けていません。',
  ].join('\n')
}

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

function normalizedEmail(value: unknown) {
  const email = normalizedText(value, 254)?.toLowerCase()
  return email && EMAIL_PATTERN.test(email) ? email : null
}

function validEmail(value: unknown) {
  const email = normalizedText(value, 254)?.toLowerCase()
  return email && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null
}

function normalizedText(value: unknown, maximumLength: number) {
  const text = String(value || '').trim()
  return text && text.length <= maximumLength ? text : null
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value)
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
