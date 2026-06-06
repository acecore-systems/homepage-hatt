export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function createOgSvg({
  title,
  description,
  image,
}: {
  title: string
  description: string
  image?: string
}) {
  const safeTitle = escapeHtml(title)
  const safeDescription = escapeHtml(description)
  const safeImage = image ? escapeHtml(image) : ''

  return `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#fbfbf7"/>
      <stop offset="0.62" stop-color="#f5fbfd"/>
      <stop offset="1" stop-color="#fff6ef"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="28" stdDeviation="22" flood-color="#151a24" flood-opacity="0.16"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1050" cy="120" r="90" fill="#9fd8e3" opacity="0.45"/>
  <circle cx="1020" cy="500" r="120" fill="#e9bc4d" opacity="0.28"/>
  <path d="M90 130 C210 70 290 210 410 142 S640 88 760 170" fill="none" stroke="#151a24" stroke-width="5" stroke-linecap="round" opacity="0.14"/>
  <rect x="74" y="76" width="1052" height="478" rx="34" fill="#ffffff" filter="url(#shadow)"/>
  ${
    safeImage
      ? `<image href="${safeImage}" x="744" y="126" width="308" height="308" preserveAspectRatio="xMidYMid slice" opacity="0.96"/>
  <rect x="744" y="126" width="308" height="308" rx="24" fill="none" stroke="#151a24" stroke-width="8" opacity="0.09"/>`
      : `<rect x="744" y="126" width="308" height="308" rx="28" fill="#e6f7f5"/>
  <path d="M810 298 C858 204 963 211 994 300 C938 332 875 336 810 298Z" fill="#8fd8c2"/>
  <path d="M876 218 L996 408" stroke="#151a24" stroke-width="9" stroke-linecap="round" opacity="0.62"/>`
  }
  <text x="130" y="160" font-family="Noto Sans JP, Arial, sans-serif" font-size="28" font-weight="700" fill="#d95c4a">Hattのホームページ</text>
  <text x="130" y="260" font-family="Noto Sans JP, Arial, sans-serif" font-size="62" font-weight="800" fill="#151a24">${safeTitle}</text>
  <foreignObject x="130" y="310" width="560" height="126">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: 'Noto Sans JP', Arial, sans-serif; color:#657085; font-size:30px; line-height:1.5; font-weight:500;">${safeDescription}</div>
  </foreignObject>
  <rect x="130" y="472" width="220" height="48" rx="24" fill="#151a24"/>
  <text x="164" y="505" font-family="Noto Sans JP, Arial, sans-serif" font-size="24" font-weight="700" fill="#ffffff">hatt.acecore.net</text>
</svg>`
}
