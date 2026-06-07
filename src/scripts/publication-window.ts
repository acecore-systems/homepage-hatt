import {
  isWithinPublicationWindow,
  parseCmsDateTime,
} from '../utils/publication-window'

const MAX_TIMER_DELAY = 2_147_483_647

let refreshTimer: number | undefined

type PublicationWindowRuntimeState = Window & {
  __hattPublicationWindowRuntimeReady?: boolean
}

const getEarlierTime = (current: number | null, candidate: number): number =>
  current === null ? candidate : Math.min(current, candidate)

function getNextRefreshTime(
  startsAt: string | undefined,
  endsAt: string | undefined,
  nowMs: number,
): number | null {
  const start = parseCmsDateTime(startsAt)
  const end = parseCmsDateTime(endsAt)
  let nextRefreshAt: number | null = null

  if (start && nowMs < start.getTime()) {
    nextRefreshAt = getEarlierTime(nextRefreshAt, start.getTime())
  }

  if (end && nowMs <= end.getTime()) {
    nextRefreshAt = getEarlierTime(nextRefreshAt, end.getTime() + 1)
  }

  return nextRefreshAt
}

function scheduleNextRefresh(
  nextRefreshAt: number | null,
  nowMs: number,
): void {
  if (refreshTimer !== undefined) {
    window.clearTimeout(refreshTimer)
    refreshTimer = undefined
  }

  if (nextRefreshAt === null) return

  const delay = Math.min(Math.max(nextRefreshAt - nowMs, 0), MAX_TIMER_DELAY)
  refreshTimer = window.setTimeout(refreshPublicationWindows, delay)
}

function refreshPublicationWindows(): void {
  const now = new Date()
  const nowMs = now.getTime()
  let nextRefreshAt: number | null = null

  document
    .querySelectorAll<HTMLElement>('[data-publication-window]')
    .forEach((element) => {
      const startsAt = element.dataset.publicationStartsAt
      const endsAt = element.dataset.publicationEndsAt

      element.hidden = !isWithinPublicationWindow(startsAt, endsAt, now)

      const elementNextRefreshAt = getNextRefreshTime(startsAt, endsAt, nowMs)
      if (elementNextRefreshAt !== null) {
        nextRefreshAt = getEarlierTime(nextRefreshAt, elementNextRefreshAt)
      }
    })

  scheduleNextRefresh(nextRefreshAt, nowMs)
}

export function initPublicationWindowRuntime(): void {
  const runtimeState = window as PublicationWindowRuntimeState

  if (runtimeState.__hattPublicationWindowRuntimeReady) {
    refreshPublicationWindows()
    return
  }

  runtimeState.__hattPublicationWindowRuntimeReady = true

  document.addEventListener('astro:page-load', refreshPublicationWindows)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshPublicationWindows()
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refreshPublicationWindows, {
      once: true,
    })
  } else {
    refreshPublicationWindows()
  }
}
