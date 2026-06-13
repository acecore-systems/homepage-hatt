import {
  isAllowedRequestOrigin,
  jsonResponse,
  normalizeText,
  optionsResponse,
  readJsonPayload,
  verifyAdminRequest,
  type PagesContext,
} from '../../_course-shared'

type PushSubscriptionPayload = {
  endpoint?: unknown
  expirationTime?: unknown
  keys?: {
    p256dh?: unknown
    auth?: unknown
  }
}

type SubscribePayload = {
  subscription?: PushSubscriptionPayload
  deviceLabel?: unknown
}

export const onRequestPost = async (
  context: PagesContext,
): Promise<Response> => {
  if (!isAllowedRequestOrigin(context.request, context.env)) {
    return jsonResponse({ ok: false, message: 'アクセスできません。' }, 403)
  }

  const auth = await verifyAdminRequest(context.request, context.env)
  if (!auth.ok) return auth.response

  if (!context.env.COMMENTS_DB) {
    return jsonResponse(
      { ok: false, message: '通知登録を保存できません。' },
      503,
    )
  }

  const payload = await readJsonPayload<SubscribePayload>(context.request)
  const validation = validateSubscriptionPayload(payload)

  if (!validation.ok) {
    return jsonResponse({ ok: false, message: validation.message }, 400)
  }

  const now = new Date().toISOString()
  const endpointHash = await hashEndpoint(validation.subscription.endpoint)

  try {
    await context.env.COMMENTS_DB.prepare(
      `INSERT INTO course_push_subscriptions (
         endpoint, endpoint_hash, subscription_json, device_label,
         created_at, last_seen_at, disabled_at, last_error
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(endpoint) DO UPDATE SET
         endpoint_hash = excluded.endpoint_hash,
         subscription_json = excluded.subscription_json,
         device_label = excluded.device_label,
         last_seen_at = excluded.last_seen_at,
         disabled_at = NULL,
         last_error = NULL`,
    )
      .bind(
        validation.subscription.endpoint,
        endpointHash,
        JSON.stringify(validation.subscription),
        validation.deviceLabel,
        now,
        now,
      )
      .run()

    return jsonResponse({
      ok: true,
      message: '通知を有効化しました。',
    })
  } catch (error) {
    console.error('Failed to save course push subscription:', error)
    return jsonResponse(
      { ok: false, message: '通知登録を保存できません。' },
      500,
    )
  }
}

export const onRequestOptions = (context: PagesContext): Response =>
  optionsResponse(context.request, context.env)

function validateSubscriptionPayload(payload: SubscribePayload | null):
  | {
      ok: true
      subscription: {
        endpoint: string
        expirationTime: number | null
        keys: { p256dh: string; auth: string }
      }
      deviceLabel: string
    }
  | { ok: false; message: string } {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: '通知登録の内容を確認してください。' }
  }

  const subscription = payload.subscription
  if (!subscription || typeof subscription !== 'object') {
    return { ok: false, message: '通知登録の内容を確認してください。' }
  }

  const endpoint = String(subscription.endpoint || '').trim()
  const p256dh = String(subscription.keys?.p256dh || '').trim()
  const auth = String(subscription.keys?.auth || '').trim()

  if (!isValidPushEndpoint(endpoint) || !p256dh || !auth) {
    return { ok: false, message: '通知登録の内容を確認してください。' }
  }

  const expirationTime =
    typeof subscription.expirationTime === 'number'
      ? Math.floor(subscription.expirationTime)
      : null
  const deviceLabel =
    normalizeText(payload.deviceLabel, 80) || 'Course admin device'

  return {
    ok: true,
    subscription: {
      endpoint,
      expirationTime,
      keys: { p256dh, auth },
    },
    deviceLabel,
  }
}

function isValidPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.includes('.')
  } catch {
    return false
  }
}

async function hashEndpoint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(endpoint),
  )

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
