import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getUploadProducts,
  hasZipSignature,
  prepareProductFileUpload,
  PRODUCT_FILE_MAX_SIZE_BYTES,
  PRODUCT_FILE_PART_SIZE_BYTES,
} from '../functions/api/shop/admin/files.ts'
import { ShopApiError } from '../functions/api/shop/_shared.ts'

test('CMS用の商品ZIP一覧には物理発送商品を含めない', () => {
  const uploadProducts = getUploadProducts()

  assert.ok(uploadProducts.length > 0)
  assert.ok(
    uploadProducts.every(
      (product) =>
        product.slug && product.title && product.fulfillmentType !== 'physical',
    ),
  )
  assert.ok(uploadProducts.some((product) => product.slug === 'eringi-sensei'))
})

test('手動納品商品にZIPを非公開R2キーで紐付ける', () => {
  const upload = prepareProductFileUpload({
    productSlug: 'eringi-sensei',
    filename: '納品データ.zip',
    size: PRODUCT_FILE_PART_SIZE_BYTES + 1,
  })

  assert.equal(upload.productSlug, 'eringi-sensei')
  assert.equal(upload.filename, '納品データ.zip')
  assert.match(
    upload.key,
    /^manual-products\/eringi-sensei\/\d{17}-[a-f0-9]{12}\.zip$/,
  )
})

test('商品に存在しないZIPと容量超過を拒否する', () => {
  assert.throws(
    () =>
      prepareProductFileUpload({
        productSlug: 'missing-product',
        filename: 'data.zip',
        size: 100,
      }),
    (error) => error instanceof ShopApiError && error.status === 404,
  )
  assert.throws(
    () =>
      prepareProductFileUpload({
        productSlug: 'eringi-sensei',
        filename: 'data.txt',
        size: 100,
      }),
    (error) => error instanceof ShopApiError && error.status === 400,
  )
  assert.throws(
    () =>
      prepareProductFileUpload({
        productSlug: 'eringi-sensei',
        filename: 'data.zip',
        size: PRODUCT_FILE_MAX_SIZE_BYTES + 1,
      }),
    (error) => error instanceof ShopApiError && error.status === 413,
  )
})

test('先頭データがZIP署名か確認する', () => {
  assert.equal(
    hasZipSignature(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer),
    true,
  )
  assert.equal(
    hasZipSignature(Uint8Array.from([0x50, 0x4b, 0x05, 0x06]).buffer),
    true,
  )
  assert.equal(
    hasZipSignature(Uint8Array.from([0x00, 0x01, 0x02, 0x03]).buffer),
    false,
  )
})
