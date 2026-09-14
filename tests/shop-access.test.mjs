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

test('AcecoreID由来の正しいAccess JWTでショップ管理者を識別する', async () => {
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
  const token = await signAccessJwt({ audience: 'different-audience' })
  const identity = await getShopAccessIdentity(
    adminRequest({ 'cf-access-jwt-assertion': token }),
    allowedEnv,
  )

  assert.equal(identity.ok, false)
  assert.equal(identity.status, 401)
})

test('AcecoreIDのapp種別ではないAccess JWTを拒否する', async () => {
  mockAccessCerts()
  const token = await signAccessJwt({ type: 'org' })
  const identity = await getShopAccessIdentity(
    adminRequest({ 'cf-access-jwt-assertion': token }),
    allowedEnv,
  )

  assert.equal(identity.ok, false)
  assert.equal(identity.status, 403)
  assert.match(identity.message, /AcecoreID/)
})

test('AcecoreID subjectがないAccess JWTを拒否する', async () => {
  mockAccessCerts()
  const token = await signAccessJwt({ includeCustomSubject: false })
  const identity = await getShopAccessIdentity(
    adminRequest({ 'cf-access-jwt-assertion': token }),
    allowedEnv,
  )

  assert.equal(identity.ok, false)
  assert.equal(identity.status, 403)
  assert.match(identity.message, /AcecoreID/)
})

test('subject claimがないAccess JWTを拒否する', async () => {
  mockAccessCerts()
  const token = await signAccessJwt({ includeJwtSubject: false })
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

async function signAccessJwt({
  audience = accessAudience,
  includeCustomSubject = true,
  includeJwtSubject = true,
  subject = '7d436933-3e18-4bbb-9513-e7bbfd80ab0f',
  jwtSubject = 'shop-admin-account',
  type = 'app',
} = {}) {
  const now = Math.floor(Date.now() / 1000)
  const payload = { email: 'Admin@Example.com', type }

  if (includeCustomSubject) {
    payload.custom = { 'https://acecore.net/claims/subject': subject }
  }

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: accessKeyId })
    .setIssuer(accessIssuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)

  if (includeJwtSubject) {
    jwt.setSubject(jwtSubject)
  }

  return jwt.sign(privateKey)
}

function mockAccessCerts() {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `${accessIssuer}/cdn-cgi/access/certs`)
    return new Response(JSON.stringify({ keys: [accessJwk] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
