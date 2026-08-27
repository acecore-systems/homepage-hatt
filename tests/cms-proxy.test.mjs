import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, test } from 'node:test'
import {
  SignJWT,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from 'jose'

import {
  isAllowedCmsDeletePath,
  isAllowedCmsDirectoryPath,
  isAllowedCmsWritePath,
  isCmsReferenceStatePath,
  normalizeCmsPath,
} from '../functions/admin/api/_cms-policy.ts'
import { getGitHubToken } from '../functions/admin/api/_github-api.ts'
import { onRequestPost as handleGraphql } from '../functions/admin/api/graphql.ts'
import { onRequest as handleGithubRest } from '../functions/admin/api/github/[[path]].ts'
import { onRequestGet as handleSession } from '../functions/admin/api/session.ts'

const originalFetch = globalThis.fetch
const mainSha = 'a'.repeat(40)
const referenceAuthorSha = '1'.repeat(40)
const referenceAuthorText = JSON.stringify({
  id: 'hatt',
  name: 'Hatt',
  bio: 'Test author',
})
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
      },
    })

    return jsonResponse(installationTokenResponse('test-installation-token'))
  })

  const token = await getGitHubToken({
    CMS_GITHUB_APP_CLIENT_ID: githubAppClientId,
    CMS_GITHUB_APP_INSTALLATION_ID: githubAppInstallationId,
    CMS_GITHUB_APP_PRIVATE_KEY: githubAppPrivateKeyPem,
  })

  assert.equal(token, 'test-installation-token')
})

test('画像と本文をmainの同じ1 commitへ直接保存する', async () => {
  const calls = []

  mockFetch(async (input, init = {}) => {
    const url = String(input)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

    calls.push({ url, init, body })

    if (url.endsWith('/git/ref/heads/main')) {
      return jsonResponse({ object: { sha: mainSha } })
    }

    if (url.endsWith('/graphql')) {
      assert.match(body.query, /mutation CmsCommit/)
      assert.equal(
        body.variables.input.branch.repositoryNameWithOwner,
        'acecore-systems/homepage-hatt',
      )
      assert.equal(body.variables.input.branch.branchName, 'main')
      assert.equal(body.variables.input.expectedHeadOid, mainSha)
      assert.match(
        body.variables.input.message.body,
        /^CMS-Operation: [0-9a-f-]{36}$/,
      )
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
                contents: validPngBytes().toString('base64'),
              },
              {
                path: 'src/content/blog/example.md',
                contents: Buffer.from(validMarkdown()).toString('base64'),
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
  assert.equal(result.extensions.cms.branch, 'main')
  assert.equal(result.extensions.cms.commit.oid, 'b'.repeat(40))
  assert.equal(result.extensions.cms.publication, 'cloudflare-pages')
  assert.equal(calls.length, 2)
  assert.equal(
    calls.some(({ url }) => url.endsWith('/git/refs')),
    false,
  )
  assert.equal(
    calls.some(({ url }) => url.endsWith('/pulls')),
    false,
  )
})

test('direct保存の応答喪失後にmarker・親SHA・path・blob SHAを照合して復旧する', async () => {
  const committedSha = 'e'.repeat(40)
  const expectedContents = Buffer.from(validMarkdown()).toString('base64')
  const expectedBlobSha = gitBlobOid(expectedContents)
  let operationMarker = ''
  let mainRefReads = 0

  mockFetch(async (input, init = {}) => {
    const url = String(input)

    if (url.endsWith('/git/ref/heads/main')) {
      mainRefReads += 1

      return jsonResponse({
        object: { sha: mainRefReads === 1 ? mainSha : committedSha },
      })
    }

    if (url.endsWith('/graphql')) {
      const body = JSON.parse(init.body)

      operationMarker = body.variables.input.message.body
      throw new TypeError('upstream response was lost')
    }

    if (url.includes('/commits?sha=main&per_page=100')) {
      return jsonResponse([
        {
          sha: committedSha,
          parents: [{ sha: mainSha }],
          commit: {
            message: `cms: update src/content/blog/example.md\n\n${operationMarker}`,
            committer: { date: '2026-07-28T00:00:00Z' },
          },
        },
      ])
    }

    if (url.endsWith(`/commits/${committedSha}?per_page=100`)) {
      return jsonResponse({
        sha: committedSha,
        files: [
          {
            filename: 'src/content/blog/example.md',
            status: 'modified',
          },
        ],
      })
    }

    if (url.includes(`/git/trees/${committedSha}?recursive=1`)) {
      return jsonResponse({
        sha: 'c'.repeat(40),
        truncated: false,
        tree: [
          {
            mode: '100644',
            path: 'src/content/blog/example.md',
            sha: expectedBlobSha,
            size: Buffer.from(validMarkdown()).byteLength,
            type: 'blob',
          },
        ],
      })
    }

    throw new Error(`Unexpected GitHub request: ${url}`)
  })

  const response = await handleGraphql({
    request: cmsSaveRequest(),
    env: allowedEnv,
  })
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.equal(result.data.createCommitOnBranch.commit.oid, committedSha)
  assert.equal(result.extensions.cms.commit.oid, committedSha)
  assert.equal(mainRefReads, 2)
})

test('markerと親SHAが一致しても変更pathが異なるcommitを成功扱いにしない', async () => {
  const committedSha = 'e'.repeat(40)
  let operationMarker = ''
  let mainRefReads = 0
  let treeRequested = false

  mockFetch(async (input, init = {}) => {
    const url = String(input)

    if (url.endsWith('/git/ref/heads/main')) {
      mainRefReads += 1
      return jsonResponse({
        object: { sha: mainRefReads === 1 ? mainSha : committedSha },
      })
    }

    if (url.endsWith('/graphql')) {
      operationMarker = JSON.parse(init.body).variables.input.message.body
      throw new TypeError('upstream response was lost')
    }

    if (url.includes('/commits?sha=main&per_page=100')) {
      return jsonResponse([
        {
          sha: committedSha,
          parents: [{ sha: mainSha }],
          commit: {
            message: `cms: update example\n\n${operationMarker}`,
            committer: { date: '2026-07-28T00:00:00Z' },
          },
        },
      ])
    }

    if (url.endsWith(`/commits/${committedSha}?per_page=100`)) {
      return jsonResponse({
        sha: committedSha,
        files: [
          {
            filename: 'src/content/blog/example.md',
            status: 'modified',
          },
          { filename: 'README.md', status: 'modified' },
        ],
      })
    }

    if (url.includes('/git/trees/')) treeRequested = true

    throw new Error(`Unexpected GitHub request: ${url}`)
  })

  const response = await handleGraphql({
    request: cmsSaveRequest(),
    env: allowedEnv,
  })

  assert.equal(response.status, 409)
  assert.match((await response.json()).message, /mainが更新されています/)
  assert.equal(treeRequested, false)
})

test('marker・親SHA・pathが一致してもblob SHAが異なるcommitを成功扱いにしない', async () => {
  const committedSha = 'e'.repeat(40)
  let operationMarker = ''
  let mainRefReads = 0

  mockFetch(async (input, init = {}) => {
    const url = String(input)

    if (url.endsWith('/git/ref/heads/main')) {
      mainRefReads += 1
      return jsonResponse({
        object: { sha: mainRefReads === 1 ? mainSha : committedSha },
      })
    }

    if (url.endsWith('/graphql')) {
      operationMarker = JSON.parse(init.body).variables.input.message.body
      throw new TypeError('upstream response was lost')
    }

    if (url.includes('/commits?sha=main&per_page=100')) {
      return jsonResponse([
        {
          sha: committedSha,
          parents: [{ sha: mainSha }],
          commit: {
            message: `cms: update example\n\n${operationMarker}`,
            committer: { date: '2026-07-28T00:00:00Z' },
          },
        },
      ])
    }

    if (url.endsWith(`/commits/${committedSha}?per_page=100`)) {
      return jsonResponse({
        sha: committedSha,
        files: [
          {
            filename: 'src/content/blog/example.md',
            status: 'modified',
          },
        ],
      })
    }

    if (url.includes(`/git/trees/${committedSha}?recursive=1`)) {
      return jsonResponse({
        sha: 'c'.repeat(40),
        truncated: false,
        tree: [
          {
            mode: '100644',
            path: 'src/content/blog/example.md',
            sha: 'f'.repeat(40),
            size: Buffer.from(validMarkdown()).byteLength,
            type: 'blob',
          },
        ],
      })
    }

    throw new Error(`Unexpected GitHub request: ${url}`)
  })

  const response = await handleGraphql({
    request: cmsSaveRequest(),
    env: allowedEnv,
  })

  assert.equal(response.status, 409)
  assert.match((await response.json()).message, /mainが更新されています/)
})

test('保存中に別commitがmainへ入った場合は上書きせず409にする', async () => {
  let operationMarker = ''
  let mainRefReads = 0

  mockFetch(async (input, init = {}) => {
    const url = String(input)

    if (url.endsWith('/git/ref/heads/main')) {
      mainRefReads += 1

      return jsonResponse({
        object: { sha: mainRefReads === 1 ? mainSha : 'f'.repeat(40) },
      })
    }

    if (url.endsWith('/graphql')) {
      const body = JSON.parse(init.body)

      operationMarker = body.variables.input.message.body
      return jsonResponse({
        errors: [{ message: 'Expected branch head did not match' }],
      })
    }

    if (url.includes('/commits?sha=main&per_page=100')) {
      return jsonResponse([
        {
          sha: 'f'.repeat(40),
          parents: [{ sha: mainSha }],
          commit: {
            message: `unrelated update\n\nnot-${operationMarker}`,
            committer: { date: '2026-07-28T00:00:00Z' },
          },
        },
      ])
    }

    throw new Error(`Unexpected GitHub request: ${url}`)
  })

  const response = await handleGraphql({
    request: cmsSaveRequest(),
    env: allowedEnv,
  })
  const result = await response.json()

  assert.equal(response.status, 409)
  assert.match(result.message, /mainが更新されています/)
})

test('編集開始後にmainが更新済みなら書き込み前に409にする', async () => {
  let callCount = 0

  mockFetch(async (input) => {
    callCount += 1
    assert.match(String(input), /git\/ref\/heads\/main$/)

    return jsonResponse({ object: { sha: 'f'.repeat(40) } })
  })

  const response = await handleGraphql({
    request: cmsSaveRequest(),
    env: allowedEnv,
  })
  const result = await response.json()

  assert.equal(response.status, 409)
  assert.match(result.message, /mainが更新されています/)
  assert.equal(callCount, 1)
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
  assert.equal(isAllowedCmsWritePath('src/content/products/example.json'), true)
  assert.equal(
    isAllowedCmsWritePath('src/content/shop-settings/main.json'),
    true,
  )
  assert.equal(
    isAllowedCmsDeletePath('src/content/products/example.json'),
    true,
  )
  assert.equal(
    isAllowedCmsDeletePath('src/content/shop-settings/main.json'),
    false,
  )

  for (const path of [
    'src/content/art/nested/example.json',
    'src/content/authors/nested/example.json',
    'src/content/blog/nested/example.md',
    'src/content/campaigns/nested/example.json',
    'src/content/modeling/nested/example.json',
    'src/content/products/nested/example.json',
    'src/content/shop-settings/other.json',
    'src/content/tags/nested/example.json',
  ]) {
    assert.equal(isAllowedCmsWritePath(path), false)
    assert.equal(isAllowedCmsDeletePath(path), false)
    assert.equal(isCmsReferenceStatePath(path), false)
  }

  assert.equal(isAllowedCmsDirectoryPath('src/content/blog/nested'), false)
  assert.equal(isAllowedCmsDirectoryPath('public/uploads/hatt/nested'), true)
  assert.equal(
    isAllowedCmsWritePath('public/uploads/hatt/nested/example.png'),
    true,
  )
})

test('collection下位directoryへのcontent保存・削除をGitHubへ送らない', async () => {
  let called = false

  mockFetch(async () => {
    called = true
    throw new Error('GitHub must not be called')
  })

  const writeResponse = await handleGraphql({
    request: cmsSaveRequest('src/content/blog/nested/example.md'),
    env: allowedEnv,
  })
  const deleteResponse = await handleGraphql({
    request: cmsDeleteRequest('src/content/blog/nested/example.md'),
    env: allowedEnv,
  })

  assert.equal(writeResponse.status, 403)
  assert.equal(deleteResponse.status, 403)
  assert.equal(called, false)
})

test('制御文字入りpathを保存・削除・履歴参照に使わせない', async () => {
  let forwarded = false

  mockFetch(async () => {
    forwarded = true
    throw new Error('GitHub must not be called')
  })

  const unsafePaths = [
    {
      graphql: 'src/content/blog/example\\n.md',
      path: 'src/content/blog/example\n.md',
    },
    {
      graphql: 'src/content/blog/example\\u007f.md',
      path: 'src/content/blog/example\u007f.md',
    },
  ]

  for (const unsafePath of unsafePaths) {
    assert.equal(normalizeCmsPath(unsafePath.path), null)

    const writeResponse = await handleGraphql({
      request: cmsSaveRequest(unsafePath.path),
      env: allowedEnv,
    })
    const deleteResponse = await handleGraphql({
      request: cmsDeleteRequest(unsafePath.path),
      env: allowedEnv,
    })
    const historyResponse = await handleGraphql({
      request: graphqlRequest({
        query: `
          query {
            repository(owner: "acecore-systems", name: "homepage-hatt") {
              ref(qualifiedName: "main") {
                target {
                  ... on Commit {
                    history(first: 1, path: "${unsafePath.graphql}") {
                      nodes { oid }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: {},
      }),
      env: allowedEnv,
    })

    assert.equal(writeResponse.status, 403)
    assert.equal(deleteResponse.status, 403)
    assert.equal(historyResponse.status, 403)
  }

  assert.equal(forwarded, false)
})

test('必須site・author・tagと参照され得るmediaの削除をGitHubへ送らない', async () => {
  let called = false

  mockFetch(async () => {
    called = true
    throw new Error('GitHub must not be called')
  })

  for (const path of [
    'src/content/site/main.json',
    'src/content/authors/hatt.json',
    'src/content/tags/announcement.json',
    'public/uploads/hatt/hatt.webp',
  ]) {
    const response = await handleGraphql({
      request: cmsDeleteRequest(path),
      env: allowedEnv,
    })

    assert.equal(response.status, 403)
    assert.equal(isAllowedCmsDeletePath(path), false)
  }

  assert.equal(isAllowedCmsDeletePath('src/content/blog/example.md'), true)
  assert.equal(isAllowedCmsDeletePath('src/content/art/example.json'), true)
  assert.equal(called, false)
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
        treeItem('src/content/blog/nested', 'tree', 'c'),
        treeItem('src/content/blog/nested/example.md', 'blob', 'd'),
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

function cmsSaveRequest(path = 'src/content/blog/example.md') {
  return graphqlRequest({
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
              path,
              contents: Buffer.from(validMarkdown()).toString('base64'),
            },
          ],
          deletions: [],
        },
        message: { headline: 'Create example' },
      },
    },
  })
}

function cmsDeleteRequest(path) {
  return graphqlRequest({
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
          additions: [],
          deletions: [{ path }],
        },
        message: { headline: 'Delete example' },
      },
    },
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
      return jsonResponse(
        installationTokenResponse('test-route-installation-token'),
      )
    }

    if (
      url.endsWith(`/git/trees/${mainSha}?recursive=1`) &&
      (init.method === undefined || init.method === 'GET')
    ) {
      return jsonResponse({
        sha: '2'.repeat(40),
        truncated: false,
        tree: [
          {
            mode: '100644',
            path: 'src/content/authors/hatt.json',
            sha: referenceAuthorSha,
            size: Buffer.byteLength(referenceAuthorText),
            type: 'blob',
          },
        ],
      })
    }

    if (url.endsWith('/graphql') && typeof init.body === 'string') {
      const body = JSON.parse(init.body)

      if (body.query?.includes('query CmsReferenceState')) {
        return jsonResponse({
          data: {
            repository: {
              blob0: {
                byteSize: Buffer.byteLength(referenceAuthorText),
                isBinary: false,
                isTruncated: false,
                text: referenceAuthorText,
              },
            },
          },
        })
      }
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

function installationTokenResponse(token) {
  return {
    token,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    permissions: {
      contents: 'write',
      metadata: 'read',
    },
    repositories: [
      {
        full_name: 'acecore-systems/homepage-hatt',
      },
    ],
  }
}

function validMarkdown(body = '# Example') {
  return [
    '---',
    'title: Example',
    'description: Example description',
    'date: 2026-07-28T12:00+09:00',
    'author: hatt',
    '---',
    body,
    '',
  ].join('\n')
}

function validPngBytes() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
}

function gitBlobOid(base64Contents) {
  const bytes = Buffer.from(base64Contents, 'base64')

  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex')
}

function treeItem(path, type, marker) {
  return {
    path,
    type,
    mode: type === 'blob' ? '100644' : '040000',
    sha: marker.repeat(40).slice(0, 40),
  }
}
