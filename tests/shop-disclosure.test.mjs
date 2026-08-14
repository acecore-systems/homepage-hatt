import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  onRequestGet,
  onRequestPost,
} from '../functions/api/shop/disclosure-request.ts'
import { settings } from '../functions/api/shop/_shared.ts'

const originalSettings = structuredClone(settings)

afterEach(() => {
  for (const key of Object.keys(settings)) delete settings[key]
  Object.assign(settings, structuredClone(originalSettings))
})

test('未設定の開示窓口は公開設定を返さない', async () => {
  const response = await onRequestGet({
    request: new Request(
      'https://hatt.acecore.net/api/shop/disclosure-request',
    ),
    env: {},
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, enabled: false })
})

test('専用Workerの販売者情報が一致しない開示窓口は公開設定を返さない', async () => {
  configureReadySellerSettings()
  const env = readyEnv(createDisclosureDatabase())
  env.DISCLOSURE_EMAIL_SERVICE = {
    async fetch() {
      return Response.json({ ok: false }, { status: 503 })
    },
  }

  const response = await onRequestGet({
    request: new Request(
      'https://hatt.acecore.net/api/shop/disclosure-request',
    ),
    env,
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, enabled: false })
})

test('所在地の開示請求をHMAC化して送信し、同一受付番号の再送を防ぐ', async () => {
  configureReadySellerSettings()
  const database = createDisclosureDatabase()
  const messages = []
  const env = {
    SHOP_DB: database,
    TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
    SHOP_DISCLOSURE_ENABLED: 'true',
    SHOP_DISCLOSURE_HMAC_SECRET: 'test-hmac-secret-with-sufficient-length',
    SHOP_DISCLOSURE_SERVICE_TOKEN:
      'test-disclosure-service-token-with-sufficient-length',
    SHOP_DISCLOSURE_TURNSTILE_SITE_KEY: '0x4AAAAAAAAAAAAAAA',
    DISCLOSURE_EMAIL_SERVICE: {
      async fetch(request) {
        const body = JSON.parse(await request.text())
        messages.push({ request, body })
        return Response.json({ ok: true, messageId: 'message-test-1' })
      },
    },
  }
  const payload = {
    requestId: '7e5d9012-2b5e-4e3f-8f7e-7f951c22a000',
    email: 'buyer@example.com',
    consent: true,
    turnstileToken: 'local-dev',
    website: '',
  }

  const first = await onRequestPost({
    request: disclosureRequest(payload),
    env,
  })
  const second = await onRequestPost({
    request: disclosureRequest(payload),
    env,
  })

  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  assert.equal(messages.length, 1)
  assert.equal(new URL(messages[0].request.url).pathname, '/v1/disclosures')
  assert.match(
    messages[0].request.headers.get('Authorization'),
    /^Bearer test-disclosure-service-token-/,
  )
  assert.deepEqual(messages[0].body, {
    requestId: payload.requestId,
    recipientEmail: 'buyer@example.com',
    profileVersion: 'v1',
    businessName: 'Hatt shop',
    sellerName: 'Hatt',
    phone: '03-0000-0000',
  })

  const receipt = database.requests.get(payload.requestId)
  assert.equal(receipt.status, 'sent')
  assert.notEqual(receipt.email_hash, payload.email)
  assert.notEqual(receipt.ip_hash, '127.0.0.1')
})

test('ハニーポット入力と異なるOriginの開示請求を拒否する', async () => {
  configureReadySellerSettings()
  const env = readyEnv(createDisclosureDatabase())
  const payload = {
    requestId: '0e5d9012-2b5e-4e3f-8f7e-7f951c22a000',
    email: 'buyer@example.com',
    consent: true,
    turnstileToken: 'local-dev',
    website: 'https://spam.example.com',
  }

  const honeypot = await onRequestPost({
    request: disclosureRequest(payload),
    env,
  })
  const crossOrigin = await onRequestPost({
    request: disclosureRequest(
      { ...payload, website: '' },
      'https://untrusted.example.com',
    ),
    env,
  })

  assert.equal(honeypot.status, 422)
  assert.equal(crossOrigin.status, 403)
})

function configureReadySellerSettings() {
  Object.assign(settings, {
    enabled: true,
    checkoutEnabled: true,
    businessName: 'Hatt shop',
    sellerName: 'Hatt',
    sellerAddress: '',
    sellerAddressDisclosureMode: 'on_request',
    sellerAddressDisclosureUrl: '/shop/legal/disclosure-request/',
    sellerAddressDisclosureProfileVersion: 'v1',
    sellerPhone: '03-0000-0000',
    sellerEmail: 'support@example.com',
    returnsPolicy: '返品ポリシー',
    privacyPolicy: 'プライバシーポリシー',
    terms: '利用条件',
  })
}

function readyEnv(database) {
  return {
    SHOP_DB: database,
    TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
    SHOP_DISCLOSURE_ENABLED: 'true',
    SHOP_DISCLOSURE_HMAC_SECRET: 'test-hmac-secret-with-sufficient-length',
    SHOP_DISCLOSURE_SERVICE_TOKEN:
      'test-disclosure-service-token-with-sufficient-length',
    SHOP_DISCLOSURE_TURNSTILE_SITE_KEY: '0x4AAAAAAAAAAAAAAA',
    DISCLOSURE_EMAIL_SERVICE: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        if (pathname === '/v1/ready') return Response.json({ ok: true })
        return Response.json({ ok: true, messageId: 'message-test-1' })
      },
    },
  }
}

function disclosureRequest(payload, origin = 'http://localhost:4321') {
  return new Request('http://localhost:4321/api/shop/disclosure-request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify(payload),
  })
}

function createDisclosureDatabase() {
  const requests = new Map()
  const rateLimits = new Map()

  return {
    requests,
    prepare(query) {
      let values = []
      const statement = {
        bind(...nextValues) {
          values = nextValues
          return statement
        },
        async all() {
          return { results: [] }
        },
        async first() {
          if (query.includes('shop_disclosure_schema_metadata')) {
            return { version: 1 }
          }
          if (
            query.includes('FROM shop_disclosure_requests') &&
            query.includes('WHERE id = ?')
          ) {
            return requests.get(values[0]) || null
          }
          if (query.includes('WHERE email_hash = ?')) {
            return (
              [...requests.values()].find(
                (request) =>
                  request.email_hash === values[0] &&
                  ['processing', 'delivery_unknown'].includes(request.status),
              ) || null
            )
          }
          if (query.includes('INSERT INTO shop_disclosure_rate_limits')) {
            const count = (rateLimits.get(values[0]) || 0) + 1
            rateLimits.set(values[0], count)
            return { request_count: count }
          }
          return null
        },
        async run() {
          if (query.includes('INSERT INTO shop_disclosure_requests')) {
            requests.set(values[0], {
              id: values[0],
              email_hash: values[1],
              ip_hash: values[2],
              status: 'processing',
            })
            return { meta: { changes: 1 } }
          }
          if (query.includes("SET status = 'sent'")) {
            const request = requests.get(values[3])
            if (
              request &&
              request.email_hash === values[4] &&
              request.status === 'processing'
            ) {
              request.status = 'sent'
              request.email_message_id = values[0]
              return { meta: { changes: 1 } }
            }
            return { meta: { changes: 0 } }
          }
          return { meta: { changes: 1 } }
        },
      }
      return statement
    },
    async batch() {
      return []
    },
  }
}
