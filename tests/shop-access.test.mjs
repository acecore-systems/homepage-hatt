import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import { getShopAccessIdentity } from '../functions/api/shop/_access-auth.ts'

const originalFetch = globalThis.fetch
const accessIssuer = 'https://shop-test.cloudflareaccess.com'
const accessAudience = 'test-shop-audience'
const accessKeyId = 'test-shop-access-key'
const accessUserUuid = 'd3bb2ddd-b684-4b14-9f1c-4d4c8cdca037'
const acecoreSubject = '7d436933-3e18-4bbb-9513-e7bbfd80ab0f'
const identityAccountId = 'db9b62f409f463da7acbcc374b8385d0'
const identityProviderId = 'a18ae74a-a342-40db-bfb2-7cc515d26637'
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
  let identityRequests = 0
  mockAccess({
    onIdentity() {
      identityRequests += 1
    },
  })
  const token = await signAccessJwt()
  const identity = await getShopAccessIdentity(
    adminRequest({ 'cf-access-jwt-assertion': token }),
    allowedEnv,
  )

  assert.deepEqual(identity, { ok: true, email: 'admin@example.com' })
  assert.equal(identityRequests, 0)
})

test('direct subjectがない場合は検証済みissuerのfull identityで補完する', async () => {
  const token = await signAccessJwt({ includeCustomSubject: false })
  let identityRequests = 0
  mockAccess({
    onIdentity(input, init) {
      identityRequests += 1
      assert.equal(String(input), `${accessIssuer}/cdn-cgi/access/get-identity`)
      assert.equal(init.method, 'GET')
      assert.equal(init.redirect, 'manual')
      assert.equal(init.cache, 'no-store')
      assert.ok(init.signal instanceof AbortSignal)
      const headers = new Headers(init.headers)
      assert.equal(headers.get('Accept'), 'application/json')
      assert.equal(headers.get('Cookie'), `CF_Authorization=${token}`)
    },
  })

  const identity = await getShopAccessIdentity(
    adminRequest({ 'cf-access-jwt-assertion': token }),
    allowedEnv,
  )

  assert.deepEqual(identity, { ok: true, email: 'admin@example.com' })
  assert.equal(identityRequests, 1)
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
  mockAccess({ identity: fullIdentity({ oidc_fields: {} }) })
  const token = await signAccessJwt({ includeCustomSubject: false })
  const identity = await getShopAccessIdentity(
    adminRequest({ 'cf-access-jwt-assertion': token }),
    allowedEnv,
  )

  assert.equal(identity.ok, false)
  assert.equal(identity.status, 403)
  assert.match(identity.message, /AcecoreID/)
})

for (const subject of ['', 'not-a-uuid', 42]) {
  test(`不正なAcecoreID subject (${JSON.stringify(subject)})を拒否する`, async () => {
    let identityRequests = 0
    mockAccess({
      onIdentity() {
        identityRequests += 1
      },
    })
    const token = await signAccessJwt({ subject })
    const identity = await getShopAccessIdentity(
      adminRequest({ 'cf-access-jwt-assertion': token }),
      allowedEnv,
    )
    assert.equal(identity.ok, false)
    assert.equal(identity.status, 403)
    assert.equal(identityRequests, 0)
  })
}

for (const custom of [null, [], 'invalid']) {
  test(`不正なdirect custom (${JSON.stringify(custom)})はfallbackせず拒否する`, async () => {
    let identityRequests = 0
    mockAccess({
      onIdentity() {
        identityRequests += 1
      },
    })
    const token = await signAccessJwt({ custom })
    const identity = await getShopAccessIdentity(
      adminRequest({ 'cf-access-jwt-assertion': token }),
      allowedEnv,
    )
    assert.equal(identity.ok, false)
    assert.equal(identity.status, 403)
    assert.equal(identityRequests, 0)
  })
}

for (const [label, value] of [
  ['user_uuid', { user_uuid: crypto.randomUUID() }],
  ['account_id', { account_id: 'different-account' }],
  ['idp.id', { idp: { id: 'different-provider', type: 'oidc' } }],
  ['idp.type', { idp: { id: identityProviderId, type: 'saml' } }],
]) {
  test(`full identityの${label}不一致を拒否する`, async () => {
    mockAccess({ identity: fullIdentity(value) })
    const token = await signAccessJwt({ includeCustomSubject: false })
    const identity = await getShopAccessIdentity(
      adminRequest({ 'cf-access-jwt-assertion': token }),
      allowedEnv,
    )
    assert.equal(identity.ok, false)
    assert.equal(identity.status, 403)
  })
}

test('full identityの非成功応答をfail closedにする', async () => {
  mockAccess({ identityResponse: new Response(null, { status: 503 }) })
  const token = await signAccessJwt({ includeCustomSubject: false })
  const identity = await getShopAccessIdentity(
    adminRequest({ 'cf-access-jwt-assertion': token }),
    allowedEnv,
  )

  assert.equal(identity.ok, false)
  assert.equal(identity.status, 502)
})

test('full identityの64 KiB超過応答をfail closedにする', async () => {
  mockAccess({
    identityResponse: new Response(
      JSON.stringify({ padding: 'x'.repeat(64 * 1024) }),
    ),
  })
  const token = await signAccessJwt({ includeCustomSubject: false })
  const identity = await getShopAccessIdentity(
    adminRequest({ 'cf-access-jwt-assertion': token }),
    allowedEnv,
  )

  assert.equal(identity.ok, false)
  assert.equal(identity.status, 502)
})

test('空のAccess subjectを拒否する', async () => {
  mockAccessCerts()
  const token = await signAccessJwt({ jwtSubject: '' })
  const identity = await getShopAccessIdentity(
    adminRequest({ 'cf-access-jwt-assertion': token }),
    allowedEnv,
  )
  assert.equal(identity.ok, false)
  assert.equal(identity.status, 403)
})

for (const missing of ['iat', 'exp']) {
  test(`${missing}のないAccess JWTを拒否する`, async () => {
    mockAccessCerts()
    const token = await signAccessJwt({ missing })
    const identity = await getShopAccessIdentity(
      adminRequest({ 'cf-access-jwt-assertion': token }),
      allowedEnv,
    )
    assert.equal(identity.ok, false)
    assert.equal(identity.status, 401)
  })
}

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
  subject = acecoreSubject,
  jwtSubject = accessUserUuid,
  type = 'app',
  missing,
  custom,
} = {}) {
  const now = Math.floor(Date.now() / 1000)
  const payload = { email: 'Admin@Example.com', type }

  if (custom !== undefined) {
    payload.custom = custom
  } else if (includeCustomSubject) {
    payload.custom = { 'https://acecore.net/claims/subject': subject }
  }

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: accessKeyId })
    .setIssuer(accessIssuer)
    .setAudience(audience)

  if (missing !== 'iat') jwt.setIssuedAt(now)
  if (missing !== 'exp') jwt.setExpirationTime(now + 300)

  if (includeJwtSubject) {
    jwt.setSubject(jwtSubject)
  }

  return jwt.sign(privateKey)
}

function mockAccess({
  identity = fullIdentity(),
  identityResponse,
  onIdentity = () => {},
} = {}) {
  globalThis.fetch = async (input, init = {}) => {
    if (String(input) === `${accessIssuer}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [accessJwk] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    onIdentity(input, init)
    assert.equal(String(input), `${accessIssuer}/cdn-cgi/access/get-identity`)
    return (
      identityResponse ||
      new Response(JSON.stringify(identity), {
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }
}

function mockAccessCerts() {
  mockAccess()
}

function fullIdentity(overrides = {}) {
  return {
    user_uuid: accessUserUuid,
    account_id: identityAccountId,
    idp: { id: identityProviderId, type: 'oidc' },
    oidc_fields: { 'https://acecore.net/claims/subject': acecoreSubject },
    ...overrides,
  }
}
