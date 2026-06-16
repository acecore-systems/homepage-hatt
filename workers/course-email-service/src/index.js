export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 })
    }

    const payload = await request.json().catch(() => null)
    const validation = validatePayload(payload)

    if (!validation.ok) {
      return Response.json(
        { ok: false, message: 'Invalid email payload' },
        { status: 400 },
      )
    }

    try {
      const result = await env.EMAIL.send(validation.message)
      return Response.json({ ok: true, messageId: result.messageId || '' })
    } catch (error) {
      console.error('Course email service failed:', error)
      return Response.json(
        {
          ok: false,
          message:
            error instanceof Error ? error.message : 'Email sending failed',
        },
        { status: 502 },
      )
    }
  },
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false }

  const from = normalizeAddress(payload.from)
  const to = Array.isArray(payload.to)
    ? payload.to.map(normalizeAddress).filter(Boolean)
    : normalizeAddress(payload.to)
  const subject = normalizeText(payload.subject, 998)
  const text = normalizeText(payload.text, 50000)
  const replyTo = normalizeEmail(payload.replyTo)

  if (
    !from ||
    (Array.isArray(to) ? to.length === 0 : !to) ||
    !subject ||
    !text
  ) {
    return { ok: false }
  }

  const message = { from, to, subject, text }
  if (replyTo) message.replyTo = replyTo

  return { ok: true, message }
}

function normalizeAddress(value) {
  if (typeof value === 'string') return normalizeEmail(value)
  if (!value || typeof value !== 'object') return null

  const email = normalizeEmail(value.email)
  const name = normalizeText(value.name, 120)
  if (!email) return null

  return name ? { email, name } : email
}

function normalizeEmail(value) {
  const email = String(value || '').trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

function normalizeText(value, maxLength) {
  const text = String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()

  return text && text.length <= maxLength ? text : ''
}
