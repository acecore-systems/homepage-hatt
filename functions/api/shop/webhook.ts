import {
  parseEmailAddress,
  parseEmailAddresses,
  sendTransactionalEmail,
} from '../../_form-shared.ts'
import {
  beginStripeEvent,
  consumeOrderReservations,
  determineFulfillmentStatus,
  finishStripeEvent,
  getDb,
  getStripeConnectedAccountId,
  itemStatusForFulfillment,
  handleApiError,
  jsonResponse,
  methodNotAllowed,
  recordFulfillmentEvent,
  releaseOrderReservations,
  type D1Database,
  type OrderItemRow,
  type PagesContext,
  type ShopEnv,
  verifyStripeWebhook,
} from './_shared.ts'

export type StripeSession = {
  id?: string
  client_reference_id?: string
  payment_intent?: string
  payment_status?: string
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

export type CheckoutEventAction =
  'paid' | 'pending' | 'failed' | 'expired' | 'attempt_failed' | 'ignore'

export const onRequestPost = async ({ request, env }: PagesContext) => {
  const db = getDb(env)

  try {
    const event = await verifyStripeWebhook(request, env)
    if (event.account !== getStripeConnectedAccountId()) {
      return jsonResponse({ ok: true, ignored: true })
    }

    const shouldProcess = await beginStripeEvent(db, event.id, event.type)
    if (!shouldProcess) {
      return jsonResponse({ ok: true, duplicate: true })
    }

    try {
      const action = getCheckoutEventAction(
        event.type,
        (event.data.object as StripeSession).payment_status,
      )

      if (action === 'paid') {
        await handleCheckoutPaid(db, env, event.data.object as StripeSession)
      } else if (action === 'pending') {
        await handleCheckoutPending(db, event.data.object as StripeSession)
      } else if (action === 'failed') {
        await handleCheckoutFailed(db, event.data.object as StripeSession)
      } else if (action === 'expired') {
        await handleCheckoutExpired(db, event.data.object as StripeSession)
      } else if (action === 'attempt_failed') {
        await handlePaymentAttemptFailed(
          db,
          event.data.object as StripePaymentIntent,
        )
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

export function getCheckoutEventAction(
  eventType: string,
  paymentStatus?: string,
): CheckoutEventAction {
  if (eventType === 'checkout.session.completed') {
    return paymentStatus === 'paid' ? 'paid' : 'pending'
  }
  if (eventType === 'checkout.session.async_payment_succeeded') return 'paid'
  if (eventType === 'checkout.session.async_payment_failed') return 'failed'
  if (eventType === 'checkout.session.expired') return 'expired'
  if (eventType === 'payment_intent.payment_failed') return 'attempt_failed'
  return 'ignore'
}

async function handleCheckoutPaid(
  db: D1Database,
  env: ShopEnv,
  session: StripeSession,
) {
  const orderId = getSessionOrderId(session)
  if (!orderId || !session.id) return

  const order = await db
    .prepare('SELECT payment_status FROM shop_orders WHERE id = ? LIMIT 1')
    .bind(orderId)
    .first<{ payment_status: string }>()
  if (!order) return

  const items = await getOrderItemsForWebhook(db, orderId)
  if (order.payment_status !== 'paid') {
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
         WHERE id = ? AND payment_status != 'paid'`,
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

  await notifySellerOfPaidOrder(db, env, orderId, session, items)
}

async function handleCheckoutPending(db: D1Database, session: StripeSession) {
  const orderId = getSessionOrderId(session)
  if (!orderId || !session.id) return

  const paymentStatus = await getOrderPaymentStatus(db, orderId)
  if (!paymentStatus || ['paid', 'expired', 'failed'].includes(paymentStatus)) {
    return
  }

  await db
    .prepare(
      `UPDATE shop_orders
       SET stripe_checkout_session_id = ?,
           stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
           customer_email = COALESCE(?, customer_email),
           customer_name = COALESCE(?, customer_name),
           payment_status = 'pending',
           updated_at = ?
       WHERE id = ? AND payment_status NOT IN ('paid', 'expired', 'failed')`,
    )
    .bind(
      session.id,
      session.payment_intent ?? null,
      session.customer_details?.email ?? null,
      session.customer_details?.name ?? null,
      new Date().toISOString(),
      orderId,
    )
    .run()
  await recordFulfillmentEvent(
    db,
    orderId,
    'payment_pending',
    'Stripeで支払い結果を確認しています。',
  )
}

async function handleCheckoutExpired(db: D1Database, session: StripeSession) {
  const orderId = getSessionOrderId(session)
  if (!orderId) return
  const paymentStatus = await getOrderPaymentStatus(db, orderId)
  if (!paymentStatus || paymentStatus === 'paid') return

  const now = new Date().toISOString()
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
    .bind(now, now, orderId)
    .run()
  await recordFulfillmentEvent(
    db,
    orderId,
    'checkout_expired',
    'Stripe Checkout Sessionが期限切れになりました。',
  )
}

async function handleCheckoutFailed(db: D1Database, session: StripeSession) {
  const orderId = getSessionOrderId(session)
  if (!orderId) return
  const paymentStatus = await getOrderPaymentStatus(db, orderId)
  if (!paymentStatus || paymentStatus === 'paid') return

  const now = new Date().toISOString()
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
    .bind(now, now, orderId)
    .run()
  await recordFulfillmentEvent(
    db,
    orderId,
    'async_payment_failed',
    'Stripeで非同期決済の失敗を確認しました。',
  )
}

async function handlePaymentAttemptFailed(
  db: D1Database,
  intent: StripePaymentIntent,
) {
  const orderId = intent.metadata?.order_id
  if (!orderId) return
  const paymentStatus = await getOrderPaymentStatus(db, orderId)
  if (!paymentStatus || paymentStatus === 'paid') return

  await db
    .prepare(
      `UPDATE shop_orders
       SET stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
           updated_at = ?
       WHERE id = ? AND payment_status != 'paid'`,
    )
    .bind(intent.id ?? null, new Date().toISOString(), orderId)
    .run()
  await recordFulfillmentEvent(
    db,
    orderId,
    'payment_attempt_failed',
    'Stripeで決済試行の失敗を確認しました。Checkoutから再試行できます。',
  )
}

async function notifySellerOfPaidOrder(
  db: D1Database,
  env: ShopEnv,
  orderId: string,
  session: StripeSession,
  items: OrderItemRow[],
) {
  const sent = await db
    .prepare(
      `SELECT id
       FROM shop_fulfillment_events
       WHERE order_id = ? AND event_type = 'seller_notification_sent'
       LIMIT 1`,
    )
    .bind(orderId)
    .first<{ id: string }>()
  if (sent) return

  const from = parseEmailAddress(env.SHOP_CONTACT_EMAIL_FROM)
  const to = parseEmailAddresses(env.SHOP_CONTACT_EMAIL_TO)
  if (!from || to.length === 0) {
    throw new Error('ショップ注文通知の送信先または送信元が未設定です。')
  }

  const message = buildSellerOrderNotification(orderId, session, items)
  try {
    await sendTransactionalEmail(env, { ...message, from, to })
    await recordFulfillmentEvent(
      db,
      orderId,
      'seller_notification_sent',
      '販売者へ注文確定メールを送信しました。',
    )
  } catch (error) {
    try {
      await recordFulfillmentEvent(
        db,
        orderId,
        'seller_notification_failed',
        `販売者への注文確定メール送信に失敗しました: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } catch (recordError) {
      console.error('Failed to record seller notification error:', recordError)
    }
    throw error
  }
}

export function buildSellerOrderNotification(
  orderId: string,
  session: StripeSession,
  items: Pick<OrderItemRow, 'title' | 'quantity' | 'fulfillment_type'>[],
) {
  const customerEmail = normalizeEmail(session.customer_details?.email)
  const customerName = String(session.customer_details?.name || '').trim()
  const total = new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: 'JPY',
    maximumFractionDigits: 0,
  }).format(session.amount_total ?? 0)
  const itemLines = items.map(
    (item) =>
      `- ${item.title} x ${item.quantity} (${item.fulfillment_type === 'manual' ? '手動納品' : item.fulfillment_type})`,
  )

  return {
    subject: `【Hatt shop】新しい注文 ${orderId}`,
    text: [
      'Hatt shopで支払い済みの注文を受け付けました。',
      '',
      `注文番号: ${orderId}`,
      `購入者: ${customerName || '未取得'}`,
      `メール: ${customerEmail || '未取得'}`,
      `合計: ${total}`,
      '',
      '商品:',
      ...itemLines,
      '',
      '手動納品が必要な商品は、購入者へ受け渡し方法を案内してください。',
      '管理画面: https://hatt.acecore.net/shop/admin/',
    ].join('\n'),
    ...(customerEmail ? { replyTo: customerEmail } : {}),
  }
}

function getSessionOrderId(session: StripeSession) {
  return session.client_reference_id || session.metadata?.order_id
}

async function getOrderPaymentStatus(db: D1Database, orderId: string) {
  const order = await db
    .prepare('SELECT payment_status FROM shop_orders WHERE id = ? LIMIT 1')
    .bind(orderId)
    .first<{ payment_status: string }>()
  return order?.payment_status ?? null
}

function normalizeEmail(value: string | undefined) {
  const email = String(value || '').trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

async function getOrderItemsForWebhook(db: D1Database, orderId: string) {
  const rows = await db
    .prepare('SELECT * FROM shop_order_items WHERE order_id = ?')
    .bind(orderId)
    .all<OrderItemRow>()
  return rows.results ?? []
}
