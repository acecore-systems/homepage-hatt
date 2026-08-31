import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { afterEach, test } from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import { onRequestGet as handleCmsProductFiles } from '../functions/admin/api/product-files.ts'
import {
  buildFilesUrl,
  formatBytes,
  getCurrentProductSlug,
  isZipFilename,
} from '../public/admin/product-files.js'

const cmsHtml = await readFile(
  new URL('../public/admin/index.html', import.meta.url),
  'utf8',
)

const originalFetch = globalThis.fetch
const accessIssuer = 'https://cms-product-files.cloudflareaccess.com'
const accessAudience = 'cms-product-files-audience'
const accessKeyId = 'cms-product-files-key'
const { privateKey, publicKey } = await generateKeyPair('RS256')
const accessJwk = await exportJWK(publicKey)

Object.assign(accessJwk, { alg: 'RS256', kid: accessKeyId, use: 'sig' })

const allowedEnv = {
  CMS_ACCESS_AUD: accessAudience,
  CMS_ACCESS_ALLOWED_EMAILS: 'hatt@example.com',
  CMS_ACCESS_HOSTNAMES: 'cms.example.com',
  CMS_ACCESS_TEAM_DOMAIN: accessIssuer,
}

afterEach(() => {
  globalThis.fetch = originalFetch
})
const shopAdmin = await readFile(
  new URL('../src/pages/shop/admin/index.astro', import.meta.url),
  'utf8',
)

test('商品ZIP管理をCMS内のダイアログとして提供する', () => {
  assert.match(cmsHtml, /data-cms-product-files-open/)
  assert.match(cmsHtml, /data-cms-product-files-dialog/)
  assert.match(cmsHtml, /type="module" src="\/admin\/product-files\.js"/)
  assert.doesNotMatch(cmsHtml, /href="\/shop\/admin\/#product-files"/)
})

test('ショップ管理画面は注文管理だけを扱う', () => {
  assert.match(shopAdmin, /data-shop-admin-orders/)
  assert.doesNotMatch(shopAdmin, /data-shop-file-/)
  assert.doesNotMatch(shopAdmin, /id="product-files"/)
})

test('CMSの商品編集URLからZIP対象商品を特定する', () => {
  const products = ['eringi-sensei', 'paper-cut-kamakiri']

  assert.equal(
    getCurrentProductSlug(
      '#/collections/products/entries/eringi-sensei',
      products,
    ),
    'eringi-sensei',
  )
  assert.equal(getCurrentProductSlug('#/collections/blog', products), '')
})

test('商品ZIP APIのURLとファイル表示値を組み立てる', () => {
  assert.equal(
    buildFilesUrl('products'),
    '/admin/api/product-files?action=products',
  )
  assert.equal(
    buildFilesUrl('list', { productSlug: 'eringi-sensei' }),
    '/admin/api/product-files?productSlug=eringi-sensei',
  )
  assert.equal(formatBytes(8 * 1024 * 1024), '8.0 MiB')
  assert.equal(isZipFilename('納品データ.ZIP'), true)
  assert.equal(isZipFilename('納品データ.txt'), false)
})

test('CMS Access認証済み編集者へZIP対象商品を返す', async () => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `${accessIssuer}/cdn-cgi/access/certs`)
    return new Response(JSON.stringify({ keys: [accessJwk] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const token = await signAccessJwt()
  const response = await handleCmsProductFiles({
    request: new Request(
      'https://cms.example.com/admin/api/product-files?action=products',
      { headers: { 'Cf-Access-Jwt-Assertion': token } },
    ),
    env: allowedEnv,
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.ok(
    payload.products.some((product) => product.slug === 'eringi-sensei'),
  )
})

test('CMS Access JWTがないZIP管理APIリクエストを拒否する', async () => {
  const response = await handleCmsProductFiles({
    request: new Request(
      'https://cms.example.com/admin/api/product-files?action=products',
    ),
    env: allowedEnv,
  })

  assert.equal(response.status, 401)
})

async function signAccessJwt() {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ email: 'hatt@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: accessKeyId })
    .setIssuer(accessIssuer)
    .setAudience(accessAudience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey)
}
