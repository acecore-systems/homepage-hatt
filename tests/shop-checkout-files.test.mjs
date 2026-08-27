import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertDigitalFilesAvailable,
  ShopApiError,
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
