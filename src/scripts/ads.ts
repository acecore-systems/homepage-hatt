declare global {
  interface Window {
    __hattAdsRuntimeInitialized?: boolean
    __hattAdsScriptLoaded?: boolean
    __hattAdsScriptPromise?: Promise<void> | null
    adsbygoogle?: unknown[]
  }
}

type AdState = 'pending' | 'requested' | 'filled' | 'empty' | 'error'

const ADS_SCRIPT_ID = 'hatt-adsense-script'
const OUTCOME_CHECK_DELAY_MS = 10000
const RETRYABLE_ERROR_PATTERN =
  /availableWidth=0|No slot size|already have ads in them/i

function getShell(slot: HTMLElement) {
  return (
    slot.closest<HTMLElement>('[data-hatt-ad-container]') ??
    slot.parentElement ??
    slot
  )
}

function setSlotState(slot: HTMLElement, state: AdState) {
  slot.dataset.hattAdState = state
  getShell(slot).dataset.hattAdState = state
}

function hideSlot(
  slot: HTMLElement,
  state: Extract<AdState, 'empty' | 'error'>,
) {
  const shell = getShell(slot)
  setSlotState(slot, state)
  shell.hidden = true
}

function hasFilledSlot(slot: HTMLElement) {
  if (slot.getAttribute('data-ad-status') === 'filled') return true

  return [...slot.querySelectorAll<HTMLIFrameElement>('iframe')].some(
    (iframe) => {
      const rect = iframe.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    },
  )
}

function updateSlotOutcome(slot: HTMLElement, forceEmptyCheck = false) {
  if (slot.getAttribute('data-ad-status') === 'unfilled') {
    hideSlot(slot, 'empty')
    return 'empty'
  }

  if (hasFilledSlot(slot)) {
    setSlotState(slot, 'filled')
    return 'filled'
  }

  if (
    forceEmptyCheck &&
    slot.getAttribute('data-adsbygoogle-status') === 'done'
  ) {
    hideSlot(slot, 'empty')
    return 'empty'
  }

  return 'pending'
}

function observeSlotOutcome(slot: HTMLElement) {
  if (slot.dataset.hattAdOutcomeObserved === '1') return
  slot.dataset.hattAdOutcomeObserved = '1'

  const observer = new MutationObserver(() => {
    const outcome = updateSlotOutcome(slot)
    if (outcome === 'filled' || outcome === 'empty') {
      observer.disconnect()
    }
  })

  observer.observe(slot, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['data-ad-status', 'data-adsbygoogle-status', 'style'],
  })

  window.setTimeout(() => {
    const outcome = updateSlotOutcome(slot, true)
    if (outcome === 'filled' || outcome === 'empty') {
      observer.disconnect()
    }
  }, OUTCOME_CHECK_DELAY_MS)
}

function ensureAdsScript(clientId: string) {
  if (window.__hattAdsScriptLoaded) return Promise.resolve()
  if (window.__hattAdsScriptPromise) return window.__hattAdsScriptPromise

  window.__hattAdsScriptPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `#${ADS_SCRIPT_ID}`,
    )
    const script = existingScript ?? document.createElement('script')

    function cleanup() {
      script.removeEventListener('load', handleLoad)
      script.removeEventListener('error', handleError)
    }

    function handleLoad() {
      window.__hattAdsScriptLoaded = true
      cleanup()
      resolve()
    }

    function handleError() {
      cleanup()
      window.__hattAdsScriptPromise = null
      script.remove()
      reject(new Error('AdSense script failed to load'))
    }

    script.id = ADS_SCRIPT_ID
    script.async = true
    script.crossOrigin = 'anonymous'
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(
      clientId,
    )}`
    script.addEventListener('load', handleLoad, { once: true })
    script.addEventListener('error', handleError, { once: true })

    if (!existingScript) {
      document.head.appendChild(script)
    }
  })

  return window.__hattAdsScriptPromise
}

function canRequestSlot(slot: HTMLElement) {
  if (slot.dataset.hattAdPushed === '1') return false
  if (slot.getAttribute('data-adsbygoogle-status')) return false

  const container =
    slot.closest<HTMLElement>('[data-hatt-ad-container]') ?? slot
  const rect = container.getBoundingClientRect()
  const style = window.getComputedStyle(container)

  if (container.hidden) return false
  if (rect.width < 160) return false
  if (style.display === 'none' || style.visibility === 'hidden') return false

  return true
}

async function requestSlot(slot: HTMLElement) {
  if (!canRequestSlot(slot)) return false

  const clientId = slot.dataset.adClient
  if (!clientId) {
    hideSlot(slot, 'error')
    return false
  }

  setSlotState(slot, 'requested')

  try {
    await ensureAdsScript(clientId)
  } catch {
    hideSlot(slot, 'error')
    return false
  }

  if (!canRequestSlot(slot)) return false

  try {
    ;(window.adsbygoogle = window.adsbygoogle || []).push({})
    slot.dataset.hattAdPushed = '1'
    observeSlotOutcome(slot)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (RETRYABLE_ERROR_PATTERN.test(message)) {
      setSlotState(slot, 'pending')
      return false
    }

    console.warn('AdSense slot request failed:', error)
    hideSlot(slot, 'error')
    return false
  }
}

function observeSlot(slot: HTMLElement) {
  if (slot.dataset.hattAdObserved === '1') return
  slot.dataset.hattAdObserved = '1'

  const container =
    slot.closest<HTMLElement>('[data-hatt-ad-container]') ?? slot
  let intersectionObserver: IntersectionObserver | null = null
  let resizeObserver: ResizeObserver | null = null

  const cleanup = () => {
    intersectionObserver?.disconnect()
    resizeObserver?.disconnect()
  }

  const attemptRequest = async () => {
    if (slot.dataset.hattAdPushed === '1') {
      cleanup()
      return
    }

    const requested = await requestSlot(slot)
    if (requested) cleanup()
  }

  if ('IntersectionObserver' in window) {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void attemptRequest()
        }
      },
      { rootMargin: '240px' },
    )
    intersectionObserver.observe(container)
  }

  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(() => {
      void attemptRequest()
    })
    resizeObserver.observe(container)
  }

  void attemptRequest()
}

function initAdSlots(root: ParentNode = document) {
  root
    .querySelectorAll<HTMLElement>('[data-hatt-ad-slot].adsbygoogle')
    .forEach((slot) => observeSlot(slot))
}

export function initAdsRuntime() {
  if (!window.__hattAdsRuntimeInitialized) {
    window.__hattAdsRuntimeInitialized = true
    document.addEventListener('astro:page-load', () => initAdSlots())
  }

  initAdSlots()
}

export {}
