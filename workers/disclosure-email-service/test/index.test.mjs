import assert from 'node:assert/strict'
import test from 'node:test'

import worker from '../src/index.ts'

const serviceToken = 'test-disclosure-service-token-with-sufficient-length'
const publicProfile = {
  profileVersion: 'v1',
  businessName: 'Hatt shop',
  sellerName: 'Hatt',
  phone: '03-0000-0000',
}

test('rejects unauthenticated disclosure requests', async () => {
  let sent = false
  const response = await worker.fetch(
    request('/v1/disclosures', disclosurePayload(), { unauthenticated: true }),
    environment({
      EMAIL: {
        send: async () => {
          sent = true
          return { messageId: 'unused' }
        },
      },
    }),
  )

  assert.equal(response.status, 401)
  assert.equal(sent, false)
})

test('reports ready only when Pages and Worker seller profiles match', async () => {
  const ready = await worker.fetch(
    request('/v1/ready', publicProfile),
    environment(),
  )
  const mismatch = await worker.fetch(
    request('/v1/ready', { ...publicProfile, phone: '03-9999-9999' }),
    environment(),
  )

  assert.equal(ready.status, 200)
  assert.deepEqual(await ready.json(), { ok: true })
  assert.equal(mismatch.status, 503)
  assert.deepEqual(await mismatch.json(), { ok: false })
})

test('sends a disclosure only through the private Worker profile', async () => {
  const sent = []
  const response = await worker.fetch(
    request('/v1/disclosures', disclosurePayload()),
    environment({
      EMAIL: {
        send: async (message) => {
          sent.push(message)
          return { messageId: 'message-123' }
        },
      },
    }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    messageId: 'message-123',
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, 'buyer@example.com')
  assert.match(sent[0].text, /テスト住所 1-2-3/)
  assert.equal(
    sent[0].headers['X-Hatt-Disclosure-Request-ID'],
    disclosurePayload().requestId,
  )
})

test('rejects disclosure payloads with unexpected fields', async () => {
  let sent = false
  const response = await worker.fetch(
    request('/v1/disclosures', {
      ...disclosurePayload(),
      address: 'injected',
    }),
    environment({
      EMAIL: {
        send: async () => {
          sent = true
          return { messageId: 'unused' }
        },
      },
    }),
  )

  assert.equal(response.status, 503)
  assert.equal(sent, false)
})

function request(path, body, options = {}) {
  const headers = new Headers({
    Authorization: `Bearer ${serviceToken}`,
    'Content-Type': 'application/json',
  })
  if (options.unauthenticated) headers.delete('Authorization')

  return new Request(`https://disclosure-email.internal${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function disclosurePayload() {
  return {
    requestId: '7e5d9012-2b5e-4e3f-8f7e-7f951c22a000',
    recipientEmail: 'buyer@example.com',
    ...publicProfile,
  }
}

function environment(overrides = {}) {
  return {
    DISCLOSURE_FROM_ADDRESS: 'noreply@hatt.acecore.net',
    DISCLOSURE_SERVICE_TOKEN: serviceToken,
    DISCLOSURE_LEGAL_DETAILS_JSON: JSON.stringify({
      version: 1,
      ...publicProfile,
      address: 'テスト住所 1-2-3',
    }),
    ...overrides,
  }
}
