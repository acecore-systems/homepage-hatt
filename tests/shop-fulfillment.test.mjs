import assert from 'node:assert/strict'
import test from 'node:test'

import {
  determineFulfillmentStatus,
  itemStatusForFulfillment,
  resolvePlatformFee,
} from '../functions/api/shop/_shared.ts'

test('手動納品を含む注文は手動納品待ちになる', () => {
  assert.equal(
    determineFulfillmentStatus([{ fulfillment_type: 'manual' }]),
    'manual_pending',
  )
  assert.equal(itemStatusForFulfillment('manual'), 'manual_pending')
})

test('物理発送は手動納品より発送準備を優先する', () => {
  assert.equal(
    determineFulfillmentStatus([
      { fulfillment_type: 'manual' },
      { fulfillment_type: 'physical' },
    ]),
    'shipping_pending',
  )
})

test('プラットフォーム手数料は注文小計の1%を切り捨てで計算する', () => {
  assert.deepEqual(resolvePlatformFee(500), {
    amountJpy: 5,
    basisPoints: 100,
    fixedJpy: 0,
  })
})
