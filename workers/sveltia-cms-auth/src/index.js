const provider = 'github'
const csrfCookieName = 'sveltia-cms-auth-csrf'
const csrfMaxAgeSeconds = 600

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const scriptString = (value) => JSON.stringify(value).replace(/</g, '\\u003c')

const deleteCsrfCookie = `${csrfCookieName}=deleted; HttpOnly; Max-Age=0; Path=/; SameSite=Lax; Secure`

const outputHTML = ({ token, error, errorCode }) => {
  const state = error ? 'error' : 'success'
  const payload = error ? { provider, error, errorCode } : { provider, token }
  const message = `authorization:${provider}:${state}:${JSON.stringify(payload)}`
  const probe = `authorizing:${provider}`

  return new Response(
    `<!doctype html>
<html>
  <body>
    <script>
      (() => {
        const probe = ${scriptString(probe)};
        const message = ${scriptString(message)};
        window.addEventListener('message', ({ data, origin }) => {
          if (data === probe) {
            window.opener?.postMessage(message, origin);
          }
        });
        window.opener?.postMessage(probe, '*');
      })();
    </script>
  </body>
</html>`,
    {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Set-Cookie': deleteCsrfCookie,
      },
    },
  )
}

const outputError = (error, errorCode) => outputHTML({ error, errorCode })

const isAllowedDomain = (domain, allowedDomains) => {
  if (!allowedDomains) return true
  if (!domain) return false

  const normalizedDomain = domain.toLowerCase()

  return allowedDomains
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .some((pattern) => {
      const regex = new RegExp(
        `^${escapeRegExp(pattern).replaceAll('\\*', '.+')}$`,
      )

      return regex.test(normalizedDomain)
    })
}

const readCsrfCookie = (cookieHeader) =>
  cookieHeader
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${csrfCookieName}=`))
    ?.slice(csrfCookieName.length + 1)

const handleAuth = async (request, env) => {
  const requestURL = new URL(request.url)
  const requestedProvider = requestURL.searchParams.get('provider')
  const siteID = requestURL.searchParams.get('site_id')

  if (requestedProvider !== provider) {
    return outputError(
      'Your Git backend is not supported by the authenticator.',
      'UNSUPPORTED_BACKEND',
    )
  }

  if (!isAllowedDomain(siteID, env.ALLOWED_DOMAINS)) {
    return outputError(
      'Your domain is not allowed to use the authenticator.',
      'UNSUPPORTED_DOMAIN',
    )
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return outputError(
      'OAuth app client ID or secret is not configured.',
      'MISCONFIGURED_CLIENT',
    )
  }

  const csrfToken = globalThis.crypto.randomUUID().replaceAll('-', '')
  const githubHostname = env.GITHUB_HOSTNAME || 'github.com'
  const authURL = new URL(`https://${githubHostname}/login/oauth/authorize`)

  authURL.searchParams.set('client_id', env.GITHUB_CLIENT_ID)
  authURL.searchParams.set('scope', env.GITHUB_SCOPE || 'repo,user')
  authURL.searchParams.set('state', csrfToken)

  return new Response('', {
    status: 302,
    headers: {
      Location: authURL.toString(),
      'Set-Cookie': `${csrfCookieName}=${csrfToken}; HttpOnly; Path=/; Max-Age=${csrfMaxAgeSeconds}; SameSite=Lax; Secure`,
    },
  })
}

const handleCallback = async (request, env) => {
  const requestURL = new URL(request.url)
  const code = requestURL.searchParams.get('code')
  const state = requestURL.searchParams.get('state')
  const csrfToken = readCsrfCookie(request.headers.get('Cookie'))

  if (!code || !state) {
    return outputError(
      'Failed to receive an authorization code. Please try again later.',
      'AUTH_CODE_REQUEST_FAILED',
    )
  }

  if (!csrfToken || state !== csrfToken) {
    return outputError(
      'Potential CSRF attack detected. Authentication flow aborted.',
      'CSRF_DETECTED',
    )
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return outputError(
      'OAuth app client ID or secret is not configured.',
      'MISCONFIGURED_CLIENT',
    )
  }

  const githubHostname = env.GITHUB_HOSTNAME || 'github.com'
  const response = await fetch(
    `https://${githubHostname}/login/oauth/access_token`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code,
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
      }),
    },
  ).catch(() => null)

  if (!response) {
    return outputError(
      'Failed to request an access token. Please try again later.',
      'TOKEN_REQUEST_FAILED',
    )
  }

  const tokenResponse = await response.json().catch(() => null)

  if (!tokenResponse) {
    return outputError(
      'Server responded with malformed data. Please try again later.',
      'MALFORMED_RESPONSE',
    )
  }

  if (tokenResponse.error) {
    return outputError(
      tokenResponse.error_description || tokenResponse.error,
      'TOKEN_REQUEST_FAILED',
    )
  }

  return outputHTML({ token: tokenResponse.access_token })
}

export default {
  async fetch(request, env) {
    const { method } = request
    const { pathname } = new URL(request.url)

    if (method === 'GET' && ['/auth', '/oauth/authorize'].includes(pathname)) {
      return handleAuth(request, env)
    }

    if (
      method === 'GET' &&
      ['/callback', '/oauth/redirect'].includes(pathname)
    ) {
      return handleCallback(request, env)
    }

    return new Response('', { status: 404 })
  },
}
