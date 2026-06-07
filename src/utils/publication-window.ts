const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/

function normalizeCmsDateTime(value: string) {
  if (!value.includes('T')) return `${value}T00:00:00+09:00`
  if (LOCAL_DATE_TIME_RE.test(value)) {
    return `${value.length === 16 ? `${value}:00` : value}+09:00`
  }
  return value
}

export function parseCmsDateTime(value?: string) {
  const trimmed = value?.trim()
  if (!trimmed) return null

  const date = new Date(normalizeCmsDateTime(trimmed))
  return Number.isNaN(date.getTime()) ? null : date
}

export function isWithinPublicationWindow(
  startsAt?: string,
  endsAt?: string,
  now = new Date(),
) {
  const start = parseCmsDateTime(startsAt)
  const end = parseCmsDateTime(endsAt)

  if (start && now < start) return false
  if (end && now > end) return false
  return true
}
