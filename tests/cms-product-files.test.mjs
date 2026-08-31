import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { afterEach, test } from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import { onRequestGet as handleCmsProductFiles } from '../functions/admin/api/product-files.ts'
import {
  buildFilesUrl,
  formatBytes,
  getProductEditorSlug,
  getProductFileContext,
  isZipFilename,
  registerProductFileFieldType,
} from '../public/admin/product-files.js'

const cmsHtml = await readFile(
  new URL('../public/admin/index.html', import.meta.url),
  'utf8',
)
const cmsConfig = await readFile(
  new URL('../public/admin/config.yml', import.meta.url),
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

test('商品ZIPを商品編集画面の専用フィールドとして提供する', () => {
  assert.match(cmsHtml, /type="module" src="\/admin\/init\.js"/)
  assert.doesNotMatch(cmsHtml, /data-cms-product-files-open/)
  assert.doesNotMatch(cmsHtml, /data-cms-product-files-dialog/)
  assert.doesNotMatch(cmsHtml, /src="\/admin\/product-files\.js"/)
  assert.match(
    cmsConfig,
    /- name: r2ObjectKey\s+label: 商品ZIP\s+hint: .+\s+widget: shop_product_file/,
  )
  assert.doesNotMatch(cmsHtml, /href="\/shop\/admin\/#product-files"/)
})

test('ショップ管理画面は注文管理だけを扱う', () => {
  assert.match(shopAdmin, /data-shop-admin-orders/)
  assert.doesNotMatch(shopAdmin, /data-shop-file-/)
  assert.doesNotMatch(shopAdmin, /id="product-files"/)
})

test('CMSの商品編集URLから保存済み商品を特定する', () => {
  assert.equal(
    getProductEditorSlug('#/collections/products/entries/eringi-sensei'),
    'eringi-sensei',
  )
  assert.equal(getProductEditorSlug('#/collections/blog'), '')
  assert.equal(
    getProductEditorSlug(
      '#/collections/products/entries/%E7%B4%99%E5%88%87%E3%82%8A',
    ),
    '紙切り',
  )
})

test('商品ZIPフィールドは保存済み商品だけを編集対象にする', () => {
  const entry = createEntry({
    fulfillmentType: 'manual',
    slug: 'eringi-sensei',
  })

  assert.deepEqual(
    getProductFileContext(
      entry,
      '#/collections/products/entries/eringi-sensei',
    ),
    {
      fulfillmentType: 'manual',
      message: '',
      persistedSlug: 'eringi-sensei',
      ready: true,
      slug: 'eringi-sensei',
    },
  )
  assert.equal(
    getProductFileContext(entry, '#/collections/products/new').ready,
    false,
  )
  assert.match(
    getProductFileContext(
      createEntry({ fulfillmentType: 'manual', slug: 'changed-slug' }),
      '#/collections/products/entries/eringi-sensei',
    ).message,
    /URLスラッグを保存/,
  )
  assert.match(
    getProductFileContext(
      createEntry({ fulfillmentType: 'physical', slug: 'physical-product' }),
      '#/collections/products/entries/physical-product',
    ).message,
    /物理発送商品/,
  )
})

test('Sveltiaへ商品ZIPカスタムフィールドを一度だけ登録する', () => {
  const registrations = []
  const cms = {
    registerFieldType(name, control) {
      registrations.push({ control, name })
    },
  }
  const globals = {
    AbortController,
    createClass(definition) {
      return definition
    },
    fetch() {},
    h() {},
    location: {
      hash: '#/collections/products/entries/eringi-sensei',
      origin: 'https://cms.example.com',
    },
  }

  registerProductFileFieldType(cms, globals)
  registerProductFileFieldType(cms, globals)

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'shop_product_file')
  assert.equal(typeof registrations[0].control.render, 'function')
  assert.equal(typeof registrations[0].control.handleUpload, 'function')
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

function createEntry(data) {
  return {
    getIn(path) {
      return data[path[1]]
    },
  }
}
