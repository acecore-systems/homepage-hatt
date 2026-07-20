import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  SignJWT,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from 'jose'

import { isAllowedCmsWritePath } from '../functions/admin/api/_cms-policy.ts'
import { getGitHubToken } from '../functions/admin/api/_github-api.ts'
import { onRequestPost as handleGraphql } from '../functions/admin/api/graphql.ts'
import { onRequest as handleGithubRest } from '../functions/admin/api/github/[[path]].ts'
import { onRequestGet as handleSession } from '../functions/admin/api/session.ts'

const originalFetch = globalThis.fetch
const mainSha = 'a'.repeat(40)
const accessIssuer = 'https://test.cloudflareaccess.com'
const accessAudience = 'test-cms-audience'
const accessCertsUrl = `${accessIssuer}/cdn-cgi/access/certs`
const accessKeyId = 'test-access-key'
const { privateKey: accessPrivateKey, publicKey: accessPublicKey } =
  await generateKeyPair('RS256')
const accessJwk = await exportJWK(accessPublicKey)
const githubAppClientId = 'Iv23testclient'
const githubAppInstallationId = '12345678'
const routeGithubAppClientId = 'Iv23routeclient'
const routeGithubAppInstallationId = '87654321'
const { privateKey: githubAppPrivateKey, publicKey: githubAppPublicKey } =
  await generateKeyPair('RS256', { extractable: true })
const githubAppPrivateKeyPem = await exportPKCS8(githubAppPrivateKey)

Object.assign(accessJwk, { alg: 'RS256', kid: accessKeyId, use: 'sig' })

const validAccessJwt = await signAccessJwt()
const allowedEnv = {
  CMS_ACCESS_AUD: accessAudience,
  CMS_ACCESS_ALLOWED_EMAILS: 'editor@example.com',
  CMS_ACCESS_TEAM_DOMAIN: accessIssuer,
  CMS_GITHUB_APP_CLIENT_ID: routeGithubAppClientId,
  CMS_GITHUB_APP_INSTALLATION_ID: routeGithubAppInstallationId,
  CMS_GITHUB_APP_PRIVATE_KEY: githubAppPrivateKeyPem,
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('GitHub Appの署名付きJWTからrepository限定installation tokenを発行する', async () => {
  mockFetch(async (input, init = {}) => {
    assert.equal(
      String(input),
      `https://api.github.com/app/installations/${githubAppInstallationId}/access_tokens`,
    )
    assert.equal(init.method, 'POST')

    const authorization = new Headers(init.headers).get('Authorization') || ''
    const { payload } = await jwtVerify(
      authorization.replace(/^Bearer /, ''),
      githubAppPublicKey,
      {
        algorithms: ['RS256'],
        issuer: githubAppClientId,
      },
    )
    const body = JSON.parse(init.body)

    assert.ok((payload.exp ?? 0) - (payload.iat ?? 0) <= 10 * 60)
    assert.deepEqual(body, {
      repositories: ['homepage-hatt'],
      permissions: {
        contents: 'write',
        pull_requests: 'write',
      },
    })

    return jsonResponse({
      token: 'test-installation-token',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
  })

  const token = await getGitHubToken({
    CMS_GITHUB_APP_CLIENT_ID: githubAppClientId,
    CMS_GITHUB_APP_INSTALLATION_ID: githubAppInstallationId,
    CMS_GITHUB_APP_PRIVATE_KEY: githubAppPrivateKeyPem,
  })

  assert.equal(token, 'test-installation-token')
})

test('画像と本文を同じ短期branchの1 commit・1 PRに保存する', async () => {
  const calls = []
  let cmsBranch = ''

  mockFetch(async (input, init = {}) => {
    const url = String(input)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

    calls.push({ url, init, body })

    if (url.endsWith('/git/ref/heads/main')) {
      return jsonResponse({ object: { sha: mainSha } })
    }

    if (url.endsWith('/git/refs')) {
      cmsBranch = body.ref.replace('refs/heads/', '')
      assert.match(cmsBranch, /^cms\/hatt\//)
      assert.equal(body.sha, mainSha)

      return jsonResponse({ ref: body.ref, object: { sha: mainSha } }, 201)
    }

    if (url.endsWith('/graphql')) {
      assert.match(body.query, /mutation CmsCommit/)
      assert.equal(
        body.variables.input.branch.repositoryNameWithOwner,
        'acecore-systems/homepage-hatt',
      )
      assert.equal(body.variables.input.branch.branchName, cmsBranch)
      assert.equal(body.variables.input.expectedHeadOid, mainSha)
      assert.deepEqual(
        body.variables.input.fileChanges.additions.map(({ path }) => path),
        ['public/uploads/hatt/example.png', 'src/content/blog/example.md'],
      )

      return jsonResponse({
        data: {
          createCommitOnBranch: {
            commit: {
              oid: 'b'.repeat(40),
              committedDate: '2026-07-10T00:00:00Z',
              file_0: { oid: 'c'.repeat(40) },
              file_1: { oid: 'd'.repeat(40) },
            },
          },
        },
      })
    }

    if (url.endsWith('/pulls')) {
      assert.equal(body.head, cmsBranch)
      assert.equal(body.base, 'main')
      assert.match(body.body, /public\/uploads\/hatt\/example\.png/)
      assert.match(body.body, /src\/content\/blog\/example\.md/)

      return jsonResponse(
        { number: 91, html_url: 'https://github.com/example/pull/91' },
        201,
      )
    }

    throw new Error(`Unexpected GitHub request: ${url}`)
  })

  const response = await handleGraphql({
    request: graphqlRequest({
      query: `
        mutation($input: CreateCommitOnBranchInput!) {
          createCommitOnBranch(input: $input) {
            commit { oid committedDate }
          }
        }
      `,
      variables: {
        input: {
          branch: {
            repositoryNameWithOwner: 'acecore-systems/homepage-hatt',
            branchName: 'main',
          },
          expectedHeadOid: mainSha,
          fileChanges: {
            additions: [
              {
                path: 'public/uploads/hatt/example.png',
                contents: Buffer.from('image').toString('base64'),
              },
              {
                path: 'src/content/blog/example.md',
                contents: Buffer.from('# Example').toString('base64'),
              },
            ],
            deletions: [],
          },
          message: { headline: 'Create example' },
        },
      },
    }),
    env: allowedEnv,
  })
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.equal(result.extensions.cms.branch, cmsBranch)
  assert.equal(result.extensions.cms.pull_request.number, 91)
  assert.equal(calls.length, 4)
})

test('CMS管理対象外の保存をGitHubへ送らない', async () => {
  let called = false

  mockFetch(async () => {
    called = true
    throw new Error('GitHub must not be called')
  })

  const response = await handleGraphql({
    request: graphqlRequest({
      query: `
        mutation($input: CreateCommitOnBranchInput!) {
          createCommitOnBranch(input: $input) { commit { oid } }
        }
      `,
      variables: {
        input: {
          branch: {
            repositoryNameWithOwner: 'acecore-systems/homepage-hatt',
            branchName: 'main',
          },
          expectedHeadOid: mainSha,
          fileChanges: {
            additions: [
              {
                path: 'README.md',
                contents: Buffer.from('blocked').toString('base64'),
              },
            ],
            deletions: [],
          },
          message: { headline: 'Blocked' },
        },
      },
    }),
    env: allowedEnv,
  })

  assert.equal(response.status, 403)
  assert.equal(called, false)
})

test('CMS設定にないcontent pathを書き込み対象にしない', () => {
  assert.equal(
    isAllowedCmsWritePath('src/content/products/example.json'),
    false,
  )
  assert.equal(
    isAllowedCmsWritePath('src/content/shop-settings/main.json'),
    false,
  )
})

test('任意のGraphQL queryをGitHub tokenで実行しない', async () => {
  let called = false

  mockFetch(async () => {
    called = true
    throw new Error('GitHub must not be called')
  })

  const response = await handleGraphql({
    request: graphqlRequest({
      query: 'query { viewer { login } }',
      variables: {},
    }),
    env: allowedEnv,
  })

  assert.equal(response.status, 403)
  assert.equal(called, false)
})

test('Sveltiaのrepository read queryだけを転送する', async () => {
  mockFetch(async (input, init = {}) => {
    assert.equal(String(input), 'https://api.github.com/graphql')

    const body = JSON.parse(init.body)

    assert.deepEqual(body.variables, {
      owner: 'acecore-systems',
      repo: 'homepage-hatt',
    })

    return jsonResponse({
      data: { repository: { defaultBranchRef: { name: 'main' } } },
    })
  })

  const response = await handleGraphql({
    request: graphqlRequest({
      query: `
        query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            defaultBranchRef { name }
          }
        }
      `,
      variables: {
        owner: 'acecore-systems',
        repo: 'homepage-hatt',
      },
    }),
    env: allowedEnv,
  })

  assert.equal(response.status, 200)
})

test('Sveltiaのfile content queryを許可済みblobだけで実行する', async () => {
  const blobSha = 'b'.repeat(40)
  let callCount = 0

  mockFetch(async (input) => {
    callCount += 1
    const url = String(input)

    if (url.includes('/git/trees/main?recursive=1')) {
      return jsonResponse({
        sha: mainSha,
        truncated: false,
        tree: [treeItem('src/content/blog/example.md', 'blob', 'b')],
      })
    }

    if (url.endsWith('/graphql')) {
      return jsonResponse({
        data: {
          repository: {
            content_0: { text: '# Example' },
            commit_0: {
              target: {
                history: {
                  nodes: [
                    {
                      author: {
                        name: 'Editor',
                        email: 'editor@example.com',
                        user: { id: 1, login: 'editor' },
                      },
                      committedDate: '2026-07-10T00:00:00Z',
                    },
                  ],
                },
              },
            },
          },
        },
      })
    }

    throw new Error(`Unexpected GitHub request: ${url}`)
  })

  const response = await handleGraphql({
    request: graphqlRequest({
      query: `
        query($owner: String!, $repo: String!, $branch: String!) {
          repository(owner: $owner, name: $repo) {
            content_0: object(oid: "${blobSha}") {
              ... on Blob { text }
            }
            commit_0: ref(qualifiedName: $branch) {
              target {
                ... on Commit {
                  history(first: 1, path: "src/content/blog/example.md") {
                    nodes {
                      author {
                        name
                        email
                        user { id: databaseId login }
                      }
                      committedDate
                    }
                  }
                }
              }
            }
          }
        }
      `,
      variables: {
        owner: 'acecore-systems',
        repo: 'homepage-hatt',
        branch: 'main',
      },
    }),
    env: allowedEnv,
  })

  assert.equal(response.status, 200)
  assert.equal(callCount, 2)
})

test('Git tree responseからCMS管理対象外のpathとblob SHAを除外する', async () => {
  mockFetch(async () => {
    return jsonResponse({
      sha: mainSha,
      truncated: false,
      tree: [
        treeItem('src', 'tree', '1'),
        treeItem('src/content', 'tree', '2'),
        treeItem('src/content/blog', 'tree', '3'),
        treeItem('src/content/blog/example.md', 'blob', '4'),
        treeItem('src/private.ts', 'blob', '5'),
        treeItem('public', 'tree', '6'),
        treeItem('public/uploads', 'tree', '7'),
        treeItem('public/uploads/hatt', 'tree', '8'),
        treeItem('public/uploads/hatt/example.png', 'blob', '9'),
        treeItem('.github', 'tree', 'a'),
        treeItem('README.md', 'blob', 'b'),
      ],
    })
  })

  const response = await handleGithubRest({
    request: githubRestRequest(
      '/admin/api/github/api/v3/repos/acecore-systems/homepage-hatt/git/trees/main?recursive=1',
    ),
    env: allowedEnv,
  })
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(
    result.tree.map(({ path }) => path),
    [
      'src',
      'src/content',
      'src/content/blog',
      'src/content/blog/example.md',
      'public',
      'public/uploads',
      'public/uploads/hatt',
      'public/uploads/hatt/example.png',
    ],
  )
})

test('CMS treeにないblob SHAは取得させない', async () => {
  let callCount = 0

  mockFetch(async () => {
    callCount += 1

    return jsonResponse({
      sha: mainSha,
      truncated: false,
      tree: [treeItem('src/content/blog/example.md', 'blob', 'b')],
    })
  })

  const response = await handleGithubRest({
    request: githubRestRequest(
      `/admin/api/github/api/v3/repos/acecore-systems/homepage-hatt/git/blobs/${'c'.repeat(40)}`,
    ),
    env: allowedEnv,
  })

  assert.equal(response.status, 403)
  assert.equal(callCount, 1)
})

test('メールヘッダーだけではAccess認証を通さない', async () => {
  const response = await handleSession({
    request: new Request('http://localhost/admin/api/session', {
      headers: {
        'Cf-Access-Authenticated-User-Email': 'editor@example.com',
      },
    }),
    env: allowedEnv,
  })

  assert.equal(response.status, 401)
})

test('未署名のAccess JWTを拒否する', async () => {
  const payload = Buffer.from(
    JSON.stringify({
      aud: accessAudience,
      email: 'editor@example.com',
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: accessIssuer,
    }),
  ).toString('base64url')
  const response = await handleSession({
    request: sessionRequest(`e30.${payload}.invalid`),
    env: allowedEnv,
  })

  assert.equal(response.status, 401)
})

test('環境変数がなくても既定のAccess検証を無効化しない', async () => {
  const response = await handleSession({
    request: sessionRequest('e30.e30.invalid'),
    env: { CMS_ACCESS_ALLOWED_EMAILS: 'editor@example.com' },
  })

  assert.equal(response.status, 401)
})

test('別audience向けのAccess JWTを拒否する', async () => {
  mockFetch(async (input) => {
    throw new Error(`Unexpected request: ${String(input)}`)
  })

  const response = await handleSession({
    request: sessionRequest(
      await signAccessJwt({ audience: 'different-application' }),
    ),
    env: allowedEnv,
  })

  assert.equal(response.status, 401)
})

test('同一ドメインでもメールallowlist未登録ユーザーを拒否する', async () => {
  const response = await handleSession({
    request: sessionRequest(
      await signAccessJwt({ email: 'other@example.com' }),
    ),
    env: {
      ...allowedEnv,
      CMS_ACCESS_ALLOWED_DOMAINS: 'example.com',
    },
  })

  assert.equal(response.status, 403)
})

function graphqlRequest(payload, token = validAccessJwt) {
  return new Request('http://localhost/admin/api/graphql', {
    method: 'POST',
    headers: {
      'Cf-Access-Jwt-Assertion': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

function githubRestRequest(path, token = validAccessJwt) {
  return new Request(`http://localhost${path}`, {
    headers: {
      'Cf-Access-Jwt-Assertion': token,
    },
  })
}

function sessionRequest(token = validAccessJwt) {
  return new Request('http://localhost/admin/api/session', {
    headers: { 'Cf-Access-Jwt-Assertion': token },
  })
}

function mockFetch(handler) {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)

    if (url === accessCertsUrl) {
      return jsonResponse({ keys: [accessJwk] })
    }

    if (
      url ===
      `https://api.github.com/app/installations/${routeGithubAppInstallationId}/access_tokens`
    ) {
      return jsonResponse({
        token: 'test-route-installation-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    }

    return handler(input, init)
  }
}

function signAccessJwt({
  audience = accessAudience,
  email = 'editor@example.com',
} = {}) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: accessKeyId })
    .setIssuer(accessIssuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(accessPrivateKey)
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function treeItem(path, type, marker) {
  return {
    path,
    type,
    mode: type === 'blob' ? '100644' : '040000',
    sha: marker.repeat(40).slice(0, 40),
  }
}
