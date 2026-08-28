import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertDigitalFilesAvailable,
  CHECKOUT_SESSION_TTL_SECONDS,
  createStripeCheckoutSession,
  ShopApiError,
  settings,
  STOCK_RESERVATION_TTL_SECONDS,
} from '../functions/api/shop/_shared.ts'

const digitalProduct = {
  slug: 'sample-avatar',
  title: 'サンプルアバター',
  fulfillmentType: 'digital',
  r2ObjectKey: 'products/sample-avatar.zip',
}

function item(product = digitalProduct) {
  return { product, quantity: 1, lineTotalJpy: 500 }
}

test('R2にないデジタル配布ファイルはCheckout開始前に拒否する', async () => {
  const checkedKeys = []

  await assert.rejects(
    () =>
      assertDigitalFilesAvailable(
        {
          SHOP_FILES: {
            async get() {
              return null
            },
            async head(key) {
              checkedKeys.push(key)
              return null
            },
          },
        },
        [item()],
      ),
    (error) =>
      error instanceof ShopApiError &&
      error.status === 503 &&
      error.message.includes('配布ファイルを準備中'),
  )

  assert.deepEqual(checkedKeys, ['products/sample-avatar.zip'])
})

test('同じ配布ファイルを参照する商品はR2を1回だけ確認する', async () => {
  const checkedKeys = []
  const supportProduct = {
    ...digitalProduct,
    slug: 'sample-avatar-support',
    title: 'サンプルアバター応援版',
  }

  await assertDigitalFilesAvailable(
    {
      SHOP_FILES: {
        async get() {
          return null
        },
        async head(key) {
          checkedKeys.push(key)
          return { key }
        },
      },
    },
    [item(), item(supportProduct)],
  )

  assert.deepEqual(checkedKeys, ['products/sample-avatar.zip'])
})

test('手動納品の商品はR2の配布ファイルを要求しない', async () => {
  const checkedKeys = []
  const manualProduct = {
    slug: 'manual-avatar',
    title: '手動納品アバター',
    fulfillmentType: 'manual',
  }

  await assertDigitalFilesAvailable(
    {
      SHOP_FILES: {
        async get() {
          return null
        },
        async head(key) {
          checkedKeys.push(key)
          return null
        },
      },
    },
    [item(manualProduct)],
  )

  assert.deepEqual(checkedKeys, [])
})

test('Checkout Sessionは在庫予約より先に期限切れになる', async () => {
  const originalFetch = globalThis.fetch
  const originalSettings = structuredClone(settings)
  let params

  try {
    Object.assign(settings, {
      stripeConnectedAccountId: 'acct_checkoutexpirytest',
      platformFeeBasisPoints: 0,
      platformFeeFixedJpy: 0,
      stripeTaxEnabled: false,
    })
    globalThis.fetch = async (_input, init) => {
      params = new URLSearchParams(init.body)
      return Response.json({
        id: 'cs_test_checkout_expiry',
        url: 'https://checkout.stripe.com/c/pay/cs_test_checkout_expiry',
      })
    }

    const startedAt = Math.floor(Date.now() / 1000)
    await createStripeCheckoutSession(
      new Request('https://hatt.acecore.net/api/shop/checkout'),
      { STRIPE_SECRET_KEY: 'sk_test_checkout_expiry' },
      'order-checkout-expiry',
      [
        {
          product: {
            slug: 'manual-product',
            title: '手動納品の商品',
            summary: '手動で受け渡す商品です。',
            priceJpy: 500,
            fulfillmentType: 'manual',
          },
          quantity: 1,
          lineTotalJpy: 500,
        },
      ],
      { required: false, amountJpy: 0 },
    )

    const expiresAt = Number(params.get('expires_at'))
    assert.equal(params.get('origin_context'), 'web')
    assert.equal(
      params.get('integration_identifier'),
      'hatt_shop_checkout_kdmtqzrw',
    )
    assert.equal(
      STOCK_RESERVATION_TTL_SECONDS,
      CHECKOUT_SESSION_TTL_SECONDS + 300,
    )
    assert.ok(expiresAt >= startedAt + CHECKOUT_SESSION_TTL_SECONDS - 1)
    assert.ok(expiresAt <= startedAt + CHECKOUT_SESSION_TTL_SECONDS + 1)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(settings)) delete settings[key]
    Object.assign(settings, originalSettings)
  }
})
