import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSellerOrderNotification,
  getCheckoutEventAction,
} from '../functions/api/shop/webhook.ts'

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
