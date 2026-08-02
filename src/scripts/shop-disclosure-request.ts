interface TurnstileRenderOptions {
  sitekey: string
  action: string
  language: string
  theme: string
  callback: (token: string) => void
  'expired-callback': () => void
  'error-callback': () => void
}

interface TurnstileApi {
  render(element: Element, options: TurnstileRenderOptions): string | number
  getResponse(widgetId: string | number): string
  reset(widgetId: string | number): void
}

interface DisclosureConfigResponse {
  ok?: boolean
  enabled?: boolean
  siteKey?: string
  action?: string
}

interface DisclosureResponse {
  ok?: boolean
  message?: string
  requestId?: string
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
    hattTrackEvent?: (name: string, parameters?: Record<string, string>) => void
  }
}

const availability = document.querySelector<HTMLElement>(
  '[data-shop-disclosure-availability]',
)
const unavailable = document.querySelector<HTMLElement>(
  '[data-shop-disclosure-unavailable]',
)
const form = document.querySelector<HTMLFormElement>(
  '[data-shop-disclosure-form]',
)
const turnstileElement = document.querySelector<HTMLElement>(
  '[data-shop-disclosure-turnstile]',
)
const submit = document.querySelector<HTMLButtonElement>(
  '[data-shop-disclosure-submit]',
)
const feedback = document.querySelector<HTMLElement>(
  '[data-shop-disclosure-feedback]',
)

function setFeedback(text: string, type?: 'success' | 'error') {
  if (!feedback) return
  feedback.textContent = text
  feedback.className = text
    ? type === 'success'
      ? 'comments-feedback comments-feedback--success'
      : type === 'error'
        ? 'comments-feedback comments-feedback--error'
        : 'comments-feedback'
    : 'comments-feedback'
}

function setUnavailable() {
  if (availability) availability.hidden = true
  if (unavailable) unavailable.hidden = false
  if (form) form.hidden = true
}

async function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return window.turnstile

  return new Promise((resolve, reject) => {
    const selector = 'script[data-shop-disclosure-turnstile-script]'
    let script = document.querySelector<HTMLScriptElement>(selector)
    const timeout = window.setTimeout(
      () => reject(new Error('Turnstile timed out')),
      8_000,
    )
    const ready = () => {
      window.clearTimeout(timeout)
      if (window.turnstile) resolve(window.turnstile)
      else reject(new Error('Turnstile is unavailable'))
    }
    const failed = () => {
      window.clearTimeout(timeout)
      reject(new Error('Turnstile failed to load'))
    }

    if (script) {
      script.addEventListener('load', ready, { once: true })
      script.addEventListener('error', failed, { once: true })
      return
    }

    script = document.createElement('script')
    script.src =
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.dataset.shopDisclosureTurnstileScript = 'true'
    script.addEventListener('load', ready, { once: true })
    script.addEventListener('error', failed, { once: true })
    document.head.append(script)
  })
}

async function initializeDisclosureForm() {
  if (!availability || !unavailable || !form || !turnstileElement || !submit) {
    return
  }

  let config: DisclosureConfigResponse
  try {
    const response = await fetch('/api/shop/disclosure-request', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    config = (await response.json()) as DisclosureConfigResponse
  } catch {
    setUnavailable()
    return
  }

  if (!config.ok || !config.enabled || !config.siteKey || !config.action) {
    setUnavailable()
    return
  }

  try {
    const turnstile = await loadTurnstile()
    let token = ''
    let requestId = crypto.randomUUID()
    let submitting = false
    let completed = false
    let submittedEmail = ''
    const widgetId = turnstile.render(turnstileElement, {
      sitekey: config.siteKey,
      action: config.action,
      language: 'ja',
      theme: turnstileElement.dataset.theme || 'light',
      callback: (value) => {
        token = value
        if (!submitting && !completed) submit.disabled = false
      },
      'expired-callback': () => {
        if (submitting || completed) return
        token = ''
        submit.disabled = true
        setFeedback(
          'セキュリティ確認の有効期限が切れました。もう一度確認してください。',
          'error',
        )
      },
      'error-callback': () => {
        if (submitting || completed) return
        token = ''
        submit.disabled = true
        setFeedback(
          'セキュリティ確認を読み込めませんでした。ページを再読み込みしてください。',
          'error',
        )
      },
    })

    availability.hidden = true
    unavailable.hidden = true
    form.hidden = false

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (submitting || completed) return

      if (!form.reportValidity() || !token) {
        setFeedback(
          token
            ? '入力内容を確認してください。'
            : 'セキュリティ確認を完了してください。',
          'error',
        )
        return
      }

      const data = new FormData(form)
      const email = String(data.get('email') || '')
        .trim()
        .toLowerCase()
      if (submittedEmail && submittedEmail !== email)
        requestId = crypto.randomUUID()
      submittedEmail = email
      const submittedToken = token
      token = ''
      submitting = true
      submit.disabled = true
      setFeedback('送信しています。')

      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requestId,
            email,
            consent: data.get('consent') === 'yes',
            turnstileToken: submittedToken,
            website: String(data.get('website') || '').trim(),
          }),
        })
        const result = (await response
          .json()
          .catch(() => ({}))) as DisclosureResponse
        if (!response.ok || !result.ok) {
          throw new Error(
            result.message ||
              '販売者情報を送信できませんでした。時間をおいてお試しください。',
          )
        }

        setFeedback(
          `${result.message || '販売者情報をメールで送信しました。'} 受付番号: ${
            result.requestId || requestId
          }`,
          'success',
        )
        completed = true
        form.reset()
        turnstileElement.hidden = true
        submit.hidden = true
        window.hattTrackEvent?.('shop_seller_disclosure_submit', {
          location: 'shop_legal_disclosure',
        })
      } catch (error) {
        setFeedback(
          error instanceof Error
            ? error.message
            : '販売者情報を送信できませんでした。時間をおいてお試しください。',
          'error',
        )
        turnstile.reset(widgetId)
      } finally {
        submitting = false
        if (!completed) submit.disabled = true
      }
    })
  } catch {
    setUnavailable()
  }
}

void initializeDisclosureForm()
