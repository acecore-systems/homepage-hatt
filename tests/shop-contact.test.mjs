import assert from 'node:assert/strict'
import { test } from 'node:test'

import { onRequestPost } from '../functions/api/shop/contact.ts'

test('ショップ問い合わせを検証してメールサービスへ送信する', async () => {
  const sentMessages = []
  const env = contactEnv(sentMessages)
  const response = await onRequestPost({
    request: contactRequest({
      name: '購入者',
      email: 'buyer@example.com',
      category: 'download',
      orderNumber: 'order_test_123',
      message: '購入した商品のダウンロード方法を確認したいです。',
      consent: true,
      turnstileToken: 'local-dev',
      website: '',
    }),
    env,
  })
  const body = await response.json()

  assert.equal(response.status, 201)
  assert.deepEqual(body, {
    ok: true,
    message: 'お問い合わせを受け付けました。',
  })
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].input, 'https://course-email/send')
  assert.equal(sentMessages[0].body.replyTo, 'buyer@example.com')
  assert.match(sentMessages[0].body.subject, /ダウンロードについて/)
  assert.match(sentMessages[0].body.text, /order_test_123/)
})

test('必須項目が不足した問い合わせを拒否する', async () => {
  const sentMessages = []
  const response = await onRequestPost({
    request: contactRequest({
      name: '購入者',
      email: 'invalid-email',
      category: 'other',
      message: '短い',
      consent: false,
      turnstileToken: 'local-dev',
      website: '',
    }),
    env: contactEnv(sentMessages),
  })

  assert.equal(response.status, 400)
  assert.equal(sentMessages.length, 0)
})

test('ハニーポットに入力された問い合わせを拒否する', async () => {
  const sentMessages = []
  const response = await onRequestPost({
    request: contactRequest({
      name: 'Bot',
      email: 'bot@example.com',
      category: 'other',
      message: '自動送信された十分に長い問い合わせ内容です。',
      consent: true,
      turnstileToken: 'local-dev',
      website: 'https://spam.example.com',
    }),
    env: contactEnv(sentMessages),
  })

  assert.equal(response.status, 400)
  assert.equal(sentMessages.length, 0)
})

test('許可していないOriginからの問い合わせを拒否する', async () => {
  const sentMessages = []
  const response = await onRequestPost({
    request: contactRequest(
      {
        name: '購入者',
        email: 'buyer@example.com',
        category: 'other',
        message: '送信元が異なる問い合わせ内容です。',
        consent: true,
        turnstileToken: 'local-dev',
        website: '',
      },
      'https://untrusted.example.com',
    ),
    env: contactEnv(sentMessages),
  })

  assert.equal(response.status, 403)
  assert.equal(sentMessages.length, 0)
})

function contactRequest(payload, origin = 'http://localhost:4321') {
  return new Request('http://localhost:4321/api/shop/contact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify(payload),
  })
}

function contactEnv(sentMessages) {
  return {
    COMMENT_ALLOWED_HOSTNAMES: 'hatt.acecore.net,homepage-hatt.pages.dev',
    SHOP_CONTACT_EMAIL_FROM: 'Hatt shop <noreply@hatt.acecore.net>',
    SHOP_CONTACT_EMAIL_TO: 'shop@example.com',
    COURSE_EMAIL_SERVICE: {
      async fetch(input, init) {
        sentMessages.push({
          input,
          body: JSON.parse(init.body),
        })
        return Response.json({ ok: true, messageId: 'message_test_123' })
      },
    },
  }
}
