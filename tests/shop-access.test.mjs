import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import { getShopAccessIdentity } from '../functions/api/shop/_access-auth.ts'

const originalFetch = globalThis.fetch
const accessIssuer = 'https://shop-test.cloudflareaccess.com'
const accessAudience = 'test-shop-audience'
const accessKeyId = 'test-shop-access-key'
const { privateKey, publicKey } = await generateKeyPair('RS256')
const accessJwk = await exportJWK(publicKey)

Object.assign(accessJwk, { alg: 'RS256', kid: accessKeyId, use: 'sig' })

const allowedEnv = {
  SHOP_ACCESS_AUD: accessAudience,
  SHOP_ACCESS_HOSTNAMES: 'shop-admin.example.com',
  SHOP_ACCESS_TEAM_DOMAIN: accessIssuer,
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('正しいAccess JWTでショップ管理者を識別する', async () => {
  mockAccessCerts()
  const token = await signAccessJwt()
  const identity = await getShopAccessIdentity(
    adminRequest({ 'cf-access-jwt-assertion': token }),
    allowedEnv,
  )

  assert.deepEqual(identity, { ok: true, email: 'admin@example.com' })
})

test('Access JWTがない管理APIリクエストを拒否する', async () => {
  const identity = await getShopAccessIdentity(adminRequest(), allowedEnv)

  assert.equal(identity.ok, false)
  assert.equal(identity.status, 401)
  assert.match(identity.message, /Cloudflare Access/)
})

test('異なるaudienceのAccess JWTを拒否する', async () => {
  mockAccessCerts()
  const token = await signAccessJwt('different-audience')
  const identity = await getShopAccessIdentity(
    adminRequest({ 'cf-access-jwt-assertion': token }),
    allowedEnv,
  )

  assert.equal(identity.ok, false)
  assert.equal(identity.status, 401)
})

test('許可していないホストからの管理APIリクエストを拒否する', async () => {
  const token = await signAccessJwt()
  const identity = await getShopAccessIdentity(
    new Request('https://untrusted.example.com/api/shop/admin/session', {
      headers: { 'cf-access-jwt-assertion': token },
    }),
    allowedEnv,
  )

  assert.equal(identity.ok, false)
  assert.equal(identity.status, 401)
})

function adminRequest(headers = {}) {
  return new Request('https://shop-admin.example.com/api/shop/admin/session', {
    headers,
  })
}

async function signAccessJwt(audience = accessAudience) {
  const now = Math.floor(Date.now() / 1000)

  return new SignJWT({ email: 'Admin@Example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: accessKeyId })
    .setIssuer(accessIssuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey)
}

function mockAccessCerts() {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `${accessIssuer}/cdn-cgi/access/certs`)
    return new Response(JSON.stringify({ keys: [accessJwk] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
