type EmailAddressInput = string | EmailAddress

type ValidatedEmailPayload =
  { ok: true; message: EmailMessageBuilder } | { ok: false }

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 })
    }

    const payload: unknown = await request.json().catch(() => null)
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

export default worker

function validatePayload(payload: unknown): ValidatedEmailPayload {
  if (!isRecord(payload)) return { ok: false }

  const from = normalizeAddress(payload.from)
  const to = Array.isArray(payload.to)
    ? payload.to.map(normalizeAddress).filter(isEmailAddressInput)
    : normalizeAddress(payload.to)
  const recipients: EmailAddressInput[] = Array.isArray(to)
    ? to
    : to
      ? [to]
      : []
  const subject = normalizeText(payload.subject, 998)
  const text = normalizeText(payload.text, 50_000)
  const replyTo = normalizeEmail(payload.replyTo)

  if (!from || recipients.length === 0 || !subject || !text) {
    return { ok: false }
  }

  const message: EmailMessageBuilder = {
    from,
    to: recipients,
    subject,
    text,
  }
  if (replyTo) message.replyTo = replyTo

  return { ok: true, message }
}

function normalizeAddress(value: unknown): EmailAddressInput | null {
  if (typeof value === 'string') return normalizeEmail(value)
  if (!isRecord(value)) return null

  const email = normalizeEmail(value.email)
  const name = normalizeText(value.name, 120)
  if (!email) return null

  return name ? { email, name } : email
}

function isEmailAddressInput(
  value: EmailAddressInput | null,
): value is EmailAddressInput {
  return value !== null
}

function normalizeEmail(value: unknown): string | null {
  const email = String(value || '').trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

function normalizeText(value: unknown, maxLength: number): string {
  const text = String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()

  return text && text.length <= maxLength ? text : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
