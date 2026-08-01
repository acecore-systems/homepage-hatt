import assert from 'node:assert/strict'
import test from 'node:test'

import worker from '../src/index.ts'

test('rejects requests other than POST', async () => {
  const response = await worker.fetch(
    new Request('https://course-email/send'),
    { EMAIL: { send: async () => ({ messageId: 'unused' }) } },
  )

  assert.equal(response.status, 404)
})

test('rejects malformed email payloads before sending', async () => {
  let called = false
  const response = await worker.fetch(
    new Request('https://course-email/send', {
      method: 'POST',
      body: JSON.stringify({ from: 'invalid', to: 'recipient@example.com' }),
    }),
    {
      EMAIL: {
        send: async () => {
          called = true
          return { messageId: 'unused' }
        },
      },
    },
  )

  assert.equal(response.status, 400)
  assert.equal(called, false)
})

test('sends only validated email payloads', async () => {
  const sent = []
  const response = await worker.fetch(
    new Request('https://course-email/send', {
      method: 'POST',
      body: JSON.stringify({
        from: { email: 'noreply@example.com', name: 'Hatt' },
        to: ['owner@example.com'],
        subject: '講座申し込み',
        text: '本文',
        replyTo: 'student@example.com',
      }),
    }),
    {
      EMAIL: {
        send: async (message) => {
          sent.push(message)
          return { messageId: 'message-123' }
        },
      },
    },
  )

  assert.equal(response.status, 200)
  assert.deepEqual(sent, [
    {
      from: { email: 'noreply@example.com', name: 'Hatt' },
      to: ['owner@example.com'],
      subject: '講座申し込み',
      text: '本文',
      replyTo: 'student@example.com',
    },
  ])
  assert.deepEqual(await response.json(), {
    ok: true,
    messageId: 'message-123',
  })
})
