import {
  getDb,
  getOrderItems,
  handleApiError,
  jsonResponse,
  methodNotAllowed,
  requireAdmin,
  type OrderRow,
  type PagesContext,
} from '../_shared'

export const onRequestGet = async ({ request, env }: PagesContext) => {
  try {
    await requireAdmin(request, env)
    const db = getDb(env)
    const rows = await db
      .prepare(
        `SELECT *
         FROM shop_orders
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all<OrderRow>()
    const orders = await Promise.all(
      (rows.results ?? []).map(async (order) => ({
        id: order.id,
        stripeCheckoutSessionId: order.stripe_checkout_session_id,
        stripeConnectedAccountId: order.stripe_connected_account_id,
        customerEmail: order.customer_email,
        customerName: order.customer_name,
        subtotalJpy: order.subtotal_jpy,
        shippingJpy: order.shipping_jpy,
        taxJpy: order.tax_jpy,
        totalJpy: order.total_jpy,
        platformFeeJpy: order.platform_fee_jpy,
        platformFeeBasisPoints: order.platform_fee_basis_points,
        platformFeeFixedJpy: order.platform_fee_fixed_jpy,
        paymentStatus: order.payment_status,
        fulfillmentStatus: order.fulfillment_status,
        trackingNumber: order.tracking_number,
        manualNote: order.manual_note,
        refundNote: order.refund_note,
        createdAt: order.created_at,
        paidAt: order.paid_at,
        items: (await getOrderItems(db, order.id)).map((item) => ({
          id: item.id,
          productSlug: item.product_slug,
          title: item.title,
          fulfillmentType: item.fulfillment_type,
          quantity: item.quantity,
          itemStatus: item.item_status,
        })),
      })),
    )

    return jsonResponse({ ok: true, orders })
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestPost = () => methodNotAllowed(['GET'])
