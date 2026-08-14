import {
  beginStripeEvent,
  consumeOrderReservations,
  finishStripeEvent,
  getDb,
  handleApiError,
  jsonResponse,
  methodNotAllowed,
  recordFulfillmentEvent,
  releaseOrderReservations,
  type D1Database,
  type OrderItemRow,
  type PagesContext,
  verifyStripeWebhook,
} from './_shared'

type StripeSession = {
  id?: string
  client_reference_id?: string
  payment_intent?: string
  customer_details?: {
    email?: string
    name?: string
    address?: unknown
  }
  amount_subtotal?: number
  amount_total?: number
  total_details?: {
    amount_tax?: number
    amount_shipping?: number
  }
  metadata?: {
    order_id?: string
  }
}

type StripePaymentIntent = {
  id?: string
  metadata?: {
    order_id?: string
  }
}

export const onRequestPost = async ({ request, env }: PagesContext) => {
  const db = getDb(env)

  try {
    const event = await verifyStripeWebhook(request, env)
    const shouldProcess = await beginStripeEvent(db, event.id, event.type)

    if (!shouldProcess) {
      return jsonResponse({ ok: true, duplicate: true })
    }

    try {
      if (event.type === 'checkout.session.completed') {
        await handleCheckoutCompleted(db, event.data.object as StripeSession)
      } else if (event.type === 'checkout.session.expired') {
        await handleCheckoutExpired(db, event.data.object as StripeSession)
      } else if (event.type === 'payment_intent.payment_failed') {
        await handlePaymentFailed(db, event.data.object as StripePaymentIntent)
      }

      await finishStripeEvent(db, event.id, 'processed')
      return jsonResponse({ ok: true })
    } catch (error) {
      await finishStripeEvent(
        db,
        event.id,
        'failed',
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestGet = () => methodNotAllowed(['POST'])

async function handleCheckoutCompleted(db: D1Database, session: StripeSession) {
  const orderId = session.client_reference_id || session.metadata?.order_id
  if (!orderId || !session.id) return

  const order = await db
    .prepare('SELECT payment_status FROM shop_orders WHERE id = ? LIMIT 1')
    .bind(orderId)
    .first<{ payment_status: string }>()

  if (!order || order.payment_status === 'paid') return

  const items = await getOrderItemsForWebhook(db, orderId)
  const fulfillmentStatus = determineFulfillmentStatus(items)
  const now = new Date().toISOString()

  await consumeOrderReservations(db, orderId)
  await db
    .prepare(
      `UPDATE shop_orders
       SET stripe_checkout_session_id = ?,
           stripe_payment_intent_id = ?,
           customer_email = ?,
           customer_name = ?,
           subtotal_jpy = COALESCE(?, subtotal_jpy),
           shipping_jpy = COALESCE(?, shipping_jpy),
           tax_jpy = COALESCE(?, tax_jpy),
           total_jpy = COALESCE(?, total_jpy),
           payment_status = 'paid',
           fulfillment_status = ?,
           shipping_address_json = ?,
           paid_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      session.id,
      session.payment_intent ?? null,
      session.customer_details?.email ?? null,
      session.customer_details?.name ?? null,
      session.amount_subtotal ?? null,
      session.total_details?.amount_shipping ?? null,
      session.total_details?.amount_tax ?? null,
      session.amount_total ?? null,
      fulfillmentStatus,
      session.customer_details?.address
        ? JSON.stringify(session.customer_details.address)
        : null,
      now,
      now,
      orderId,
    )
    .run()

  await db.batch(
    items.map((item) =>
      db
        .prepare(
          `UPDATE shop_order_items
           SET item_status = ?
           WHERE id = ?`,
        )
        .bind(itemStatusForFulfillment(item.fulfillment_type), item.id),
    ),
  )
  await recordFulfillmentEvent(
    db,
    orderId,
    'paid',
    'Stripe Webhookで支払い完了を確認しました。',
  )
}

async function handleCheckoutExpired(db: D1Database, session: StripeSession) {
  const orderId = session.client_reference_id || session.metadata?.order_id
  if (!orderId) return

  await releaseOrderReservations(db, orderId)
  await db
    .prepare(
      `UPDATE shop_orders
       SET payment_status = 'expired',
           fulfillment_status = 'canceled',
           canceled_at = ?,
           updated_at = ?
       WHERE id = ? AND payment_status != 'paid'`,
    )
    .bind(new Date().toISOString(), new Date().toISOString(), orderId)
    .run()
  await recordFulfillmentEvent(
    db,
    orderId,
    'checkout_expired',
    'Stripe Checkout Sessionが期限切れになりました。',
  )
}

async function handlePaymentFailed(
  db: D1Database,
  intent: StripePaymentIntent,
) {
  const orderId = intent.metadata?.order_id
  if (!orderId) return

  await releaseOrderReservations(db, orderId)
  await db
    .prepare(
      `UPDATE shop_orders
       SET payment_status = 'failed',
           fulfillment_status = 'canceled',
           canceled_at = ?,
           updated_at = ?
       WHERE id = ? AND payment_status != 'paid'`,
    )
    .bind(new Date().toISOString(), new Date().toISOString(), orderId)
    .run()
  await recordFulfillmentEvent(
    db,
    orderId,
    'payment_failed',
    'Stripe Webhookで支払い失敗を確認しました。',
  )
}

async function getOrderItemsForWebhook(db: D1Database, orderId: string) {
  const rows = await db
    .prepare('SELECT * FROM shop_order_items WHERE order_id = ?')
    .bind(orderId)
    .all<OrderItemRow>()
  return rows.results ?? []
}

function determineFulfillmentStatus(items: OrderItemRow[]) {
  if (items.some((item) => item.fulfillment_type === 'physical')) {
    return 'shipping_pending'
  }
  if (items.some((item) => item.fulfillment_type === 'manual')) {
    return 'manual_pending'
  }
  return 'digital_ready'
}

function itemStatusForFulfillment(fulfillmentType: string) {
  if (fulfillmentType === 'physical') return 'shipping_pending'
  if (fulfillmentType === 'manual') return 'manual_pending'
  return 'digital_ready'
}
