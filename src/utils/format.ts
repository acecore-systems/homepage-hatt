export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(date)
}

export function formatYear(date: Date) {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
  }).format(date)
}
