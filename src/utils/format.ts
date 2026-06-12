const BLOG_TIME_ZONE = 'Asia/Tokyo'

export function getYear(date: Date) {
  return Number(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: BLOG_TIME_ZONE,
      year: 'numeric',
    }).format(date),
  )
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: BLOG_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(date)
}

export function formatYear(date: Date) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: BLOG_TIME_ZONE,
    year: 'numeric',
  }).format(date)
}
