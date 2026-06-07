const LOCAL_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIMEZONE_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/i

function normalizeCmsDateTime(value: string): string {
  const trimmed = value.trim()

  if (trimmed.length === 0) return trimmed
  if (DATE_ONLY_PATTERN.test(trimmed)) return `${trimmed}T00:00:00+09:00`
  if (TIMEZONE_PATTERN.test(trimmed)) return trimmed
  if (LOCAL_DATE_TIME_PATTERN.test(trimmed)) {
    return `${trimmed}${trimmed.length === 16 ? ':00' : ''}+09:00`
  }

  return trimmed
}

export function parseCmsDateTime(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  if (typeof value !== 'string') return null

  const date = new Date(normalizeCmsDateTime(value))
  return Number.isNaN(date.getTime()) ? null : date
}

export function isWithinPublicationWindow(
  startsAt?: unknown,
  endsAt?: unknown,
  now = new Date(),
): boolean {
  const start = parseCmsDateTime(startsAt)
  const end = parseCmsDateTime(endsAt)
  const nowMs = now.getTime()

  if (start && nowMs < start.getTime()) return false
  if (end && nowMs > end.getTime()) return false

  return true
}
