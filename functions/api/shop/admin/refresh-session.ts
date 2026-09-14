import {
  isAllowedShopAccessHostname,
  type ShopAccessEnv,
} from '../_access-auth.ts'

type RefreshSessionContext = {
  request: Request
  env: ShopAccessEnv
}

export const onRequest = async ({ request, env }: RefreshSessionContext) => {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }

  const url = new URL(request.url)
  if (
    !isAllowedShopAccessHostname(url.hostname.toLowerCase(), env) ||
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
