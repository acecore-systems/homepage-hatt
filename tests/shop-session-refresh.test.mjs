import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { onRequest } from '../functions/api/shop/admin/refresh-session.ts'

const origin = 'https://hatt.acecore.net'
const allowedEnv = {}

test('Shop再ログインは同一origin POSTでhost-only Cookieだけを破棄する', async () => {
  const response = await onRequest({
    request: new Request(`${origin}/api/shop/admin/refresh-session`, {
      method: 'POST',
      headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
    }),
    env: allowedEnv,
  })

  assert.equal(response.status, 303)
  assert.equal(response.headers.get('Location'), '/shop/admin/')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(
    response.headers.get('Set-Cookie'),
    'CF_Authorization=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
  )
})

for (const [method, requestOrigin, site, hostname] of [
  ['GET', origin, 'same-origin', 'hatt.acecore.net'],
  ['POST', '', 'same-origin', 'hatt.acecore.net'],
  ['POST', 'https://evil.example', 'cross-site', 'hatt.acecore.net'],
  ['POST', origin, 'same-site', 'hatt.acecore.net'],
  ['POST', 'https://untrusted.example', 'same-origin', 'untrusted.example'],
]) {
  test('Shop再ログインは不正な操作を拒否する', async () => {
    const response = await onRequest({
      request: new Request(
        `https://${hostname}/api/shop/admin/refresh-session`,
        {
          method,
          headers: { Origin: requestOrigin, 'Sec-Fetch-Site': site },
        },
      ),
      env: allowedEnv,
    })

    assert.ok([403, 405].includes(response.status))
    assert.equal(response.headers.get('Set-Cookie'), null)
  })
}

test('Shop管理画面はGET logoutではなく専用POSTフォームを使う', async () => {
  const source = await readFile(
    new URL('../src/pages/shop/admin/index.astro', import.meta.url),
    'utf8',
  )

  assert.match(
    source,
    /<form action="\/api\/shop\/admin\/refresh-session" method="post">/,
  )
  assert.match(source, /AcecoreIDで再ログイン/)
  assert.doesNotMatch(source, /\/cdn-cgi\/access\/logout/)
})
