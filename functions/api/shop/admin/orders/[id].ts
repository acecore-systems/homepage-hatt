import {
  assertSameOriginRequest,
  getDb,
  handleApiError,
  jsonResponse,
  methodNotAllowed,
  readJson,
  recordFulfillmentEvent,
  requireAdmin,
  type PagesContext,
} from '../../_shared'

type UpdatePayload = {
  fulfillmentStatus?: unknown
  trackingNumber?: unknown
  manualNote?: unknown
  refundNote?: unknown
}

const FULFILLMENT_STATUSES = new Set([
  'pending',
  'digital_ready',
  'manual_pending',
  'manual_complete',
  'shipping_pending',
  'shipped',
  'complete',
  'canceled',
])

export const onRequestPatch = async ({
  request,
  env,
  params,
}: PagesContext) => {
  try {
    assertSameOriginRequest(request)
    await requireAdmin(request, env)

    const orderId = Array.isArray(params?.id) ? params?.id[0] : params?.id
    if (!orderId) {
      return jsonResponse({ ok: false, message: '注文が見つかりません。' }, 404)
    }

    const payload = await readJson<UpdatePayload>(request)
    const fulfillmentStatus = normalizeOptional(payload.fulfillmentStatus)
    const trackingNumber = normalizeOptional(payload.trackingNumber)
    const manualNote = normalizeOptional(payload.manualNote)
    const refundNote = normalizeOptional(payload.refundNote)

    if (fulfillmentStatus && !FULFILLMENT_STATUSES.has(fulfillmentStatus)) {
      return jsonResponse(
        { ok: false, message: 'ステータスを確認してください。' },
        400,
      )
    }

    const db = getDb(env)
    const existing = await db
      .prepare('SELECT id FROM shop_orders WHERE id = ? LIMIT 1')
      .bind(orderId)
      .first<{ id: string }>()

    if (!existing) {
      return jsonResponse({ ok: false, message: '注文が見つかりません。' }, 404)
    }

    await db
      .prepare(
        `UPDATE shop_orders
         SET fulfillment_status = COALESCE(?, fulfillment_status),
             tracking_number = ?,
             manual_note = ?,
             refund_note = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        fulfillmentStatus,
        trackingNumber,
        manualNote,
        refundNote,
        new Date().toISOString(),
        orderId,
      )
      .run()
    await recordFulfillmentEvent(
      db,
      orderId,
      'admin_update',
      '管理画面から注文情報を更新しました。',
      'admin',
    )

    return jsonResponse({ ok: true })
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestGet = () => methodNotAllowed(['PATCH'])
export const onRequestPost = () => methodNotAllowed(['PATCH'])

function normalizeOptional(value: unknown) {
  const normalized = String(value ?? '').trim()
  return normalized ? normalized.slice(0, 2000) : null
}
