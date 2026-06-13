/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface Window {
  dataLayer: Record<string, unknown>[]
  gtag?: (
    command: string,
    eventName: string,
    params?: Record<string, unknown>,
  ) => void
  hattTrackEvent?: (eventName: string, params?: Record<string, unknown>) => void
}
