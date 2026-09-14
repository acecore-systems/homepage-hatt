type RefreshSessionContext = {
  request: Request
}

const SHOP_ADMIN_ORIGINS = new Set([
  'https://hatt.acecore.net',
  'https://www.hatt.acecore.net',
])

export const onRequest = async ({ request }: RefreshSessionContext) => {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }

  const url = new URL(request.url)
  if (
    !SHOP_ADMIN_ORIGINS.has(url.origin) ||
    request.headers.get('Origin') !== url.origin ||
    ['cross-site', 'same-site'].includes(
      request.headers.get('Sec-Fetch-Site') || '',
    )
  ) {
    return new Response(null, { status: 403 })
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: '/shop/admin/',
      'Cache-Control': 'no-store',
      'Set-Cookie':
        'CF_Authorization=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    },
  })
}
