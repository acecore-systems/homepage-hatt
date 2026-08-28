import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSellerOrderNotification,
  getCheckoutEventAction,
} from '../functions/api/shop/webhook.ts'
import { beginStripeEvent } from '../functions/api/shop/_shared.ts'

test('Checkout完了はpaidを確認してから注文を確定する', () => {
  assert.equal(
    getCheckoutEventAction('checkout.session.completed', 'paid'),
    'paid',
  )
  assert.equal(
    getCheckoutEventAction('checkout.session.completed', 'unpaid'),
    'pending',
  )
  assert.equal(
    getCheckoutEventAction('checkout.session.completed', 'no_payment_required'),
    'pending',
  )
})

test('非同期決済の成功と失敗を最終結果として処理する', () => {
  assert.equal(
    getCheckoutEventAction('checkout.session.async_payment_succeeded'),
    'paid',
  )
  assert.equal(
    getCheckoutEventAction('checkout.session.async_payment_failed'),
    'failed',
  )
  assert.equal(getCheckoutEventAction('checkout.session.expired'), 'expired')
})

test('PaymentIntentの一時的な失敗ではCheckoutを打ち切らない', () => {
  assert.equal(
    getCheckoutEventAction('payment_intent.payment_failed'),
    'attempt_failed',
  )
})

test('販売者通知に購入者と手動納品対象を含める', () => {
  const notification = buildSellerOrderNotification(
    'order-notification-test',
    {
      customer_details: {
        email: 'buyer@example.com',
        name: '購入者',
      },
      amount_total: 1500,
    },
    [
      {
        title: '3Dモデル',
        quantity: 1,
        fulfillment_type: 'manual',
      },
    ],
  )

  assert.match(notification.subject, /order-notification-test/)
  assert.match(notification.text, /buyer@example\.com/)
  assert.match(notification.text, /3Dモデル x 1 \(手動納品\)/)
  assert.match(notification.text, /￥1,500/)
  assert.equal(notification.replyTo, 'buyer@example.com')
})

test('Stripeイベントは完了済みと処理中の重複を無視し、失敗と停止処理を再試行する', async () => {
  const processed = duplicateEventDb({
    processing_status: 'processed',
    received_at: new Date().toISOString(),
  })
  assert.equal(
    await beginStripeEvent(processed.db, 'evt_processed', 'test'),
    false,
  )
  assert.equal(processed.updates.length, 0)

  const processing = duplicateEventDb({
    processing_status: 'processing',
    received_at: new Date().toISOString(),
  })
  assert.equal(
    await beginStripeEvent(processing.db, 'evt_processing', 'test'),
    false,
  )
  assert.equal(processing.updates.length, 0)

  const failed = duplicateEventDb({
    processing_status: 'failed',
    received_at: new Date().toISOString(),
  })
  assert.equal(await beginStripeEvent(failed.db, 'evt_failed', 'test'), true)
  assert.equal(failed.updates.length, 1)

  const stale = duplicateEventDb({
    processing_status: 'processing',
    received_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
  })
  assert.equal(await beginStripeEvent(stale.db, 'evt_stale', 'test'), true)
  assert.equal(stale.updates.length, 1)
})

function duplicateEventDb(existing) {
  const updates = []
  return {
    updates,
    db: {
      prepare(query) {
        let values = []
        const statement = {
          bind(...nextValues) {
            values = nextValues
            return statement
          },
          async run() {
            if (query.includes('INSERT INTO stripe_events')) {
              throw new Error('UNIQUE constraint failed')
            }
            updates.push({ query, values })
            return {}
          },
          async first() {
            return existing
          },
          async all() {
            return { results: [] }
          },
        }
        return statement
      },
      async batch() {
        return []
      },
    },
  }
}
