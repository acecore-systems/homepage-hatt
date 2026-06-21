import {
  assertCheckoutReady,
  assertSameOriginRequest,
  cleanupExpiredReservations,
  createPendingOrder,
  createStripeCheckoutSession,
  getDb,
  handleApiError,
  jsonResponse,
  methodNotAllowed,
  normalizeCartItems,
  readJson,
  recordFulfillmentEvent,
  releaseOrderReservations,
  reserveStock,
  resolveShipping,
  type PagesContext,
  validateCart,
  ensureStockRows,
} from './_shared'

type CheckoutPayload = {
  items?: unknown
}

export const onRequestPost = async ({ request, env }: PagesContext) => {
  try {
    assertSameOriginRequest(request)
    assertCheckoutReady()

    const db = getDb(env)
    await ensureStockRows(db)
    await cleanupExpiredReservations(db)

    const payload = await readJson<CheckoutPayload>(request)
    const items = validateCart(normalizeCartItems(payload.items))
    const shipping = resolveShipping(items)
    const orderId = await createPendingOrder(db, items, shipping)

    try {
      await reserveStock(db, orderId, items)
      const session = await createStripeCheckoutSession(
        request,
        env,
        orderId,
        items,
        shipping,
      )
      const now = new Date().toISOString()

      await db.batch([
        db
          .prepare(
            `UPDATE shop_orders
             SET stripe_checkout_session_id = ?,
                 stripe_payment_intent_id = ?,
                 payment_status = 'checkout_created',
                 updated_at = ?
             WHERE id = ?`,
          )
          .bind(session.id, session.payment_intent ?? null, now, orderId),
        db
          .prepare(
            `UPDATE shop_stock_reservations
             SET stripe_session_id = ?
             WHERE order_id = ? AND status = 'active'`,
          )
          .bind(session.id, orderId),
      ])
      await recordFulfillmentEvent(
        db,
        orderId,
        'checkout_created',
        'Stripe Checkout Sessionを作成しました。',
      )

      return jsonResponse({ ok: true, url: session.url, orderId })
    } catch (error) {
      await releaseOrderReservations(db, orderId)
      await db
        .prepare(
          `UPDATE shop_orders
           SET payment_status = 'failed', fulfillment_status = 'canceled', updated_at = ?
           WHERE id = ?`,
        )
        .bind(new Date().toISOString(), orderId)
        .run()
      throw error
    }
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestOptions = () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })

export const onRequestGet = () => methodNotAllowed(['POST', 'OPTIONS'])
