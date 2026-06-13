import {
  createDownloadToken,
  getDb,
  getOrderBySession,
  getOrderItems,
  handleApiError,
  jsonResponse,
  methodNotAllowed,
  type PagesContext,
} from './_shared'

export const onRequestGet = async ({ request, env }: PagesContext) => {
  try {
    const db = getDb(env)
    const sessionId = new URL(request.url).searchParams.get('session_id') || ''

    if (!/^cs_(test|live)_[A-Za-z0-9_]+$/.test(sessionId)) {
      return jsonResponse({ ok: false, message: '注文が見つかりません。' }, 404)
    }

    const order = await getOrderBySession(db, sessionId)
    if (!order || order.payment_status !== 'paid') {
      return jsonResponse({ ok: false, message: '注文が見つかりません。' }, 404)
    }

    const items = await getOrderItems(db, order.id)
    const publicItems = await Promise.all(
      items.map(async (item) => {
        const downloadToken =
          item.fulfillment_type === 'digital' &&
          item.item_status === 'digital_ready'
            ? await createDownloadToken(db, env, item)
            : null

        return {
          id: item.id,
          productSlug: item.product_slug,
          title: item.title,
          category: item.category,
          fulfillmentType: item.fulfillment_type,
          quantity: item.quantity,
          unitPriceJpy: item.unit_price_jpy,
          totalPriceJpy: item.total_price_jpy,
          itemStatus: item.item_status,
          downloadUrl: downloadToken
            ? `/api/shop/download?token=${encodeURIComponent(downloadToken)}`
            : null,
        }
      }),
    )

    return jsonResponse({
      ok: true,
      order: {
        id: order.id,
        customerEmail: order.customer_email,
        currency: order.currency,
        subtotalJpy: order.subtotal_jpy,
        shippingJpy: order.shipping_jpy,
        taxJpy: order.tax_jpy,
        totalJpy: order.total_jpy,
        paymentStatus: order.payment_status,
        fulfillmentStatus: order.fulfillment_status,
        trackingNumber: order.tracking_number,
        paidAt: order.paid_at,
        items: publicItems,
      },
    })
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestPost = () => methodNotAllowed(['GET'])
