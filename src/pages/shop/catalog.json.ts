import { getShopProducts, getShopSettings } from '@/lib/shop/content'
import { canCheckout, toPublicProduct } from '@/lib/shop/types'

export async function GET() {
  const [products, settings] = await Promise.all([
    getShopProducts(),
    getShopSettings(),
  ])

  return new Response(
    JSON.stringify({
      products: products.map(toPublicProduct),
      checkoutReady: canCheckout(settings),
      currency: settings.currency,
    }),
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=0, must-revalidate',
      },
    },
  )
}
