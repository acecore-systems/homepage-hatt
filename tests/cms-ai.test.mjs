import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { afterEach, test } from 'node:test'
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair } from 'jose'

import { onRequest as handleJobs } from '../functions/admin/api/ai/jobs/[[path]].ts'
import { onRequest as handleConversations } from '../functions/admin/api/ai/conversations/[[path]].ts'
import { onRequest as handleRunner } from '../functions/api/cms-ai/runner/[[path]].ts'
import {
  CmsAiError,
  normalizeReasoningEffort,
  normalizeTargetUrl,
} from '../functions/admin/api/ai/_shared.ts'
import {
  isAiWritablePath,
  parseInferenceResponse,
  runCmsAiInference,
} from '../functions/admin/api/ai/_runner.ts'

const originalFetch = globalThis.fetch
const accessIssuer = 'https://cms-ai-test.cloudflareaccess.com'
const accessAudience = 'cms-ai-test-access-audience'
const actionsIssuer = 'https://cms-ai-test.actions.example'
const actionsAudience = 'https://hatt.acecore.net/api/cms-ai/runner'
const accessKeyId = 'cms-ai-access-key'
const actionsKeyId = 'cms-ai-actions-key'
const { privateKey: accessPrivateKey, publicKey: accessPublicKey } =
  await generateKeyPair('RS256')
const { privateKey: actionsPrivateKey, publicKey: actionsPublicKey } =
  await generateKeyPair('RS256')
const { privateKey: appPrivateKey } = await generateKeyPair('RS256', {
  extractable: true,
})
const accessJwk = await exportJWK(accessPublicKey)
const actionsJwk = await exportJWK(actionsPublicKey)
const appPrivateKeyPem = await exportPKCS8(appPrivateKey)

Object.assign(accessJwk, { alg: 'RS256', kid: accessKeyId, use: 'sig' })
Object.assign(actionsJwk, { alg: 'RS256', kid: actionsKeyId, use: 'sig' })

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('CMS AIはHattのURLだけを対象にする', () => {
  const env = {}

  assert.equal(
    normalizeTargetUrl('https://hatt.acecore.net/about/#heading', env),
    'https://hatt.acecore.net/about/',
  )
  assert.equal(
    normalizeTargetUrl('https://preview.homepage-hatt.pages.dev/', env),
    'https://preview.homepage-hatt.pages.dev/',
  )
  assert.throws(
    () => normalizeTargetUrl('https://example.com/', env),
    CmsAiError,
  )
  assert.throws(
    () => normalizeTargetUrl('http://hatt.acecore.net/', env),
    CmsAiError,
  )
})

test('AIの考える深さはlow・medium・highだけを受け付ける', () => {
  assert.equal(normalizeReasoningEffort('low'), 'low')
  assert.equal(normalizeReasoningEffort('medium'), 'medium')
  assert.equal(normalizeReasoningEffort('high'), 'high')
  assert.equal(normalizeReasoningEffort(''), 'medium')
  assert.throws(() => normalizeReasoningEffort('max'), CmsAiError)
})

test('AIの変更はサイト表示・コンテンツ範囲だけを許可する', () => {
  assert.equal(isAiWritablePath('src/pages/about.astro'), true)
  assert.equal(isAiWritablePath('public/site.css'), true)
  assert.equal(isAiWritablePath('docs/guide.md'), true)
  assert.equal(isAiWritablePath('.github/workflows/ci.yml'), false)
  assert.equal(isAiWritablePath('functions/admin/api/graphql.ts'), false)
  assert.equal(isAiWritablePath('functions/api/shop/checkout.ts'), false)
  assert.equal(isAiWritablePath('tests/cms-ai.test.mjs'), false)

  assert.throws(
    () =>
      parseInferenceResponse({
        response: {
          changes: [
            {
              content: 'name: unsafe',
              path: '.github/workflows/ci.yml',
              reason: 'unsafe',
            },
          ],
          clarification: '',
          summary: 'unsafe',
        },
      }),
    CmsAiError,
  )
})

test('JSON schema形式を使えない推論は同じモデルのJSON応答へ安全に再試行する', async () => {
  let calls = 0
  const job = {
    assistantMessage: null,
    attachmentJson: '[]',
    attachments: [],
    branchName: 'ai/cms-22222222-2222-4222-8222-222222222222',
    changedPaths: [],
    clarification: null,
    conversationId: '22222222-2222-4222-8222-222222222222',
    createdAt: '2026-08-28T00:00:00.000Z',
    deploymentUrl: null,
    errorMessage: null,
    id: '22222222-2222-4222-8222-222222222222',
    instruction: '対象ページの余白を直してください。',
    prUrl: null,
    reasoningEffort: 'high',
    requestedBy: 'editor@example.com',
    status: 'running',
    summary: null,
    targetUrl: 'https://hatt.acecore.net/example/',
    turnNumber: 1,
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
  const result = await runCmsAiInference(
    {
      AI: {
        async run(_model, input) {
          calls += 1

          if (calls === 1) {
            assert.equal(input.response_format.type, 'json_schema')
            assert.equal(input.reasoning_effort, 'high')
            throw new Error('JSON Mode could not be met')
          }

          assert.equal('response_format' in input, false)
          assert.equal(input.reasoning_effort, 'high')
          return {
            response: JSON.stringify({
              changes: [
                {
                  content: '<main>updated</main>\n',
                  path: 'src/pages/example.astro',
                  reason: '余白を修正します。',
                },
              ],
              clarification: '',
              summary: '対象ページを更新しました。',
            }),
          }
        },
      },
    },
    job,
    [{ content: '<main>before</main>\n', path: 'src/pages/example.astro' }],
  )

  assert.equal(calls, 2)
  assert.equal(result.changes[0].path, 'src/pages/example.astro')
})

test('Access認証済みのCMS依頼はeffortとともにD1へ保存してGitHub Actionsを起動する', async () => {
  const db = createDatabase()
  const dispatched = []
  const env = createEnv({ db })

  mockFetch(async (url, init = {}) => {
    if (url === accessIssuer + '/cdn-cgi/access/certs') {
      return jsonResponse({ keys: [accessJwk] })
    }
    if (url === actionsIssuer + '/.well-known/jwks') {
      return jsonResponse({ keys: [actionsJwk] })
    }
    if (url.endsWith('/access_tokens')) {
      return jsonResponse(installationTokenResponse())
    }
    if (url.endsWith('/dispatches')) {
      dispatched.push(JSON.parse(String(init.body)))
      return new Response(null, { status: 204 })
    }

    throw new Error('Unexpected fetch: ' + url)
  })

  const form = new FormData()
  form.set('targetUrl', 'https://hatt.acecore.net/about/')
  form.set('instruction', '見出しの余白を少し狭くしてください。')
  form.set('reasoningEffort', 'high')
  const response = await handleJobs({
    request: new Request('http://localhost/admin/api/ai/jobs', {
      body: form,
      headers: {
        'Cf-Access-Jwt-Assertion': await signAccessJwt('editor@example.com'),
        Origin: 'http://localhost',
      },
      method: 'POST',
    }),
    env,
  })
  const payload = await response.json()

  assert.equal(response.status, 202)
  assert.match(payload.job.id, /^[0-9a-f-]{36}$/)
  assert.equal(payload.job.status, 'queued')
  assert.equal(payload.job.attachmentCount, 0)
  assert.equal(payload.job.conversationId, payload.job.id)
  assert.equal(payload.job.turnNumber, 1)
  assert.equal(payload.job.reasoningEffort, 'high')
  assert.equal(dispatched.length, 1)
  assert.deepEqual(dispatched[0], {
    client_payload: {
      conversation_id: payload.job.id,
      job_id: payload.job.id,
    },
    event_type: 'cms-ai-job',
  })
  const otherResponse = await handleJobs({
    request: new Request(
      'http://localhost/admin/api/ai/jobs/' +
        encodeURIComponent(payload.job.id),
      {
        headers: {
          'Cf-Access-Jwt-Assertion': await signAccessJwt('other@example.com'),
        },
      },
    ),
    env,
  })

  assert.equal(otherResponse.status, 404)

  const imageForm = new FormData()
  imageForm.set('targetUrl', 'https://hatt.acecore.net/about/')
  imageForm.set('instruction', 'この参考画像に合わせてください。')
  imageForm.set('reasoningEffort', 'medium')
  imageForm.set(
    'referenceImage',
    new File([validPngBytes()], 'reference.png', { type: 'image/png' }),
  )
  const imageResponse = await handleJobs({
    request: new Request('http://localhost/admin/api/ai/jobs', {
      body: imageForm,
      headers: {
        'Cf-Access-Jwt-Assertion': await signAccessJwt('editor@example.com'),
        Origin: 'http://localhost',
      },
      method: 'POST',
    }),
    env,
  })

  assert.equal(imageResponse.status, 400)
  assert.match(
    (await imageResponse.json()).message,
    /参考画像に対応していません/,
  )
})

test('CMS AIの追加入力は同じ会話・branch・Pull Requestへ新しいターンとして保存する', async () => {
  const db = createDatabase()
  const dispatched = []
  const env = createEnv({ db })

  mockFetch(async (url, init = {}) => {
    if (url === accessIssuer + '/cdn-cgi/access/certs') {
      return jsonResponse({ keys: [accessJwk] })
    }
    if (url.endsWith('/access_tokens')) {
      return jsonResponse(installationTokenResponse())
    }
    if (url.endsWith('/dispatches')) {
      dispatched.push(JSON.parse(String(init.body)))
      return new Response(null, { status: 204 })
    }

    throw new Error('Unexpected fetch: ' + url)
  })

  const initialForm = new FormData()
  initialForm.set('targetUrl', 'https://hatt.acecore.net/about/')
  initialForm.set('instruction', '見出しの余白を少し狭くしてください。')
  initialForm.set('reasoningEffort', 'medium')
  const initialResponse = await handleJobs({
    request: new Request('http://localhost/admin/api/ai/jobs', {
      body: initialForm,
      headers: {
        'Cf-Access-Jwt-Assertion': await signAccessJwt('editor@example.com'),
        Origin: 'http://localhost',
      },
      method: 'POST',
    }),
    env,
  })
  const initialPayload = await initialResponse.json()
  const conversationId = initialPayload.job.conversationId
  const firstRow = db.rows.get(initialPayload.job.id)

  const blockedForm = new FormData()
  blockedForm.set('instruction', '処理中の追加入力です。')
  blockedForm.set('reasoningEffort', 'low')
  const blockedResponse = await handleConversations({
    request: new Request(
      'http://localhost/admin/api/ai/conversations/' +
        conversationId +
        '/messages',
      {
        body: blockedForm,
        headers: {
          'Cf-Access-Jwt-Assertion': await signAccessJwt('editor@example.com'),
          Origin: 'http://localhost',
        },
        method: 'POST',
      },
    ),
    env,
  })

  assert.equal(blockedResponse.status, 409)

  db.rows.set(initialPayload.job.id, {
    ...firstRow,
    assistant_message: '見出しの余白を調整しました。',
    pr_url: 'https://github.com/acecore-systems/homepage-hatt/pull/123',
    status: 'pr_created',
    summary: 'Pull Requestを作成しました。',
  })

  const followUpForm = new FormData()
  followUpForm.set('instruction', 'もう少しだけ狭くしてください。')
  followUpForm.set('reasoningEffort', 'high')
  const followUpResponse = await handleConversations({
    request: new Request(
      'http://localhost/admin/api/ai/conversations/' +
        conversationId +
        '/messages',
      {
        body: followUpForm,
        headers: {
          'Cf-Access-Jwt-Assertion': await signAccessJwt('editor@example.com'),
          Origin: 'http://localhost',
        },
        method: 'POST',
      },
    ),
    env,
  })
  const followUpPayload = await followUpResponse.json()

  assert.equal(followUpResponse.status, 202)
  assert.equal(followUpPayload.conversation.id, conversationId)
  assert.equal(followUpPayload.conversation.jobs.length, 2)
  assert.equal(followUpPayload.conversation.jobs[1].turnNumber, 2)
  assert.equal(followUpPayload.conversation.jobs[1].reasoningEffort, 'high')
  assert.equal(
    followUpPayload.conversation.jobs[1].prUrl,
    'https://github.com/acecore-systems/homepage-hatt/pull/123',
  )
  assert.equal(
    db.rows.get(followUpPayload.conversation.jobs[1].id).branch_name,
    firstRow.branch_name,
  )
  assert.deepEqual(dispatched.at(-1), {
    client_payload: {
      conversation_id: conversationId,
      job_id: followUpPayload.conversation.jobs[1].id,
    },
    event_type: 'cms-ai-job',
  })

  const listResponse = await handleConversations({
    request: new Request('http://localhost/admin/api/ai/conversations', {
      headers: {
        'Cf-Access-Jwt-Assertion': await signAccessJwt('editor@example.com'),
      },
    }),
    env,
  })
  const listPayload = await listResponse.json()

  assert.equal(listResponse.status, 200)
  assert.equal(listPayload.conversations.length, 1)
  assert.equal(listPayload.conversations[0].id, conversationId)
  assert.equal(listPayload.conversations[0].turnCount, 2)

  const otherResponse = await handleConversations({
    request: new Request(
      'http://localhost/admin/api/ai/conversations/' + conversationId,
      {
        headers: {
          'Cf-Access-Jwt-Assertion': await signAccessJwt('other@example.com'),
        },
      },
    ),
    env,
  })

  assert.equal(otherResponse.status, 404)
})

test('GitHub Actions OIDCのrunnerだけがモデルへ変更案を依頼できる', async () => {
  const db = createDatabase()
  const modelRequests = []
  const env = createEnv({
    ai: {
      async run(model, input) {
        modelRequests.push({ input, model })
        return {
          response: {
            changes: [
              {
                content: '<main>updated</main>\n',
                path: 'src/pages/example.astro',
                reason: '依頼された余白の確認用変更です。',
              },
            ],
            clarification: '',
            summary: '対象ページを更新しました。',
          },
        }
      },
    },
    db,
  })
  const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const previousJobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const jobId = '11111111-1111-4111-8111-111111111111'
  const now = new Date().toISOString()

  db.rows.set(previousJobId, {
    assistant_message: '見出しの余白を少し狭くしました。',
    attachment_json: '[]',
    branch_name: 'ai/cms-' + conversationId,
    changed_paths_json: '["src/pages/example.astro"]',
    clarification: null,
    conversation_id: conversationId,
    created_at: new Date(Date.now() - 1000).toISOString(),
    deployment_url: null,
    error_message: null,
    id: previousJobId,
    instruction: '見出しの余白を少し狭くしてください。',
    pr_url: 'https://github.com/acecore-systems/homepage-hatt/pull/123',
    reasoning_effort: 'medium',
    requested_by: 'editor@example.com',
    status: 'pr_created',
    summary: 'Pull Requestを作成しました。',
    target_url: 'https://hatt.acecore.net/example/',
    turn_number: 1,
    updated_at: now,
  })
  db.rows.set(jobId, {
    assistant_message: null,
    attachment_json: '[]',
    branch_name: 'ai/cms-' + conversationId,
    changed_paths_json: '[]',
    clarification: null,
    conversation_id: conversationId,
    created_at: now,
    deployment_url: null,
    error_message: null,
    id: jobId,
    instruction: 'もう少しだけ狭くしてください。',
    pr_url: 'https://github.com/acecore-systems/homepage-hatt/pull/123',
    reasoning_effort: 'high',
    requested_by: 'editor@example.com',
    status: 'queued',
    summary: null,
    target_url: 'https://hatt.acecore.net/example/',
    turn_number: 2,
    updated_at: now,
  })

  mockFetch(async (url) => {
    if (url === actionsIssuer + '/.well-known/jwks') {
      return jsonResponse({ keys: [actionsJwk] })
    }

    throw new Error('Unexpected fetch: ' + url)
  })

  const response = await handleRunner({
    request: new Request('http://localhost/api/cms-ai/runner/inference', {
      body: JSON.stringify({
        files: [
          {
            content: '<main>before</main>\n',
            path: 'src/pages/example.astro',
          },
        ],
        jobId,
      }),
      headers: {
        Authorization: 'Bearer ' + (await signActionsJwt()),
        'Content-Type': 'application/json',
      },
      method: 'POST',
    }),
    env,
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.result.changes[0].path, 'src/pages/example.astro')
  assert.equal(modelRequests.length, 1)
  assert.equal(modelRequests[0].model, '@cf/zai-org/glm-5.3')
  assert.equal(modelRequests[0].input.reasoning_effort, 'high')
  assert.equal(modelRequests[0].input.response_format.type, 'json_schema')
  assert.deepEqual(
    modelRequests[0].input.messages.slice(1, 4).map((message) => message.role),
    ['user', 'assistant', 'user'],
  )
  assert.match(
    modelRequests[0].input.messages[1].content,
    /見出しの余白を少し狭く/,
  )
  assert.match(
    modelRequests[0].input.messages[2].content,
    /見出しの余白を少し狭くしました/,
  )

  const rejected = await handleRunner({
    request: new Request('http://localhost/api/cms-ai/runner/inference', {
      body: JSON.stringify({
        files: [
          {
            content: '<main>before</main>\n',
            path: 'src/pages/example.astro',
          },
        ],
        jobId,
      }),
      headers: {
        Authorization:
          'Bearer ' +
          (await signActionsJwt({
            repository: 'attacker/other-repository',
          })),
        'Content-Type': 'application/json',
      },
      method: 'POST',
    }),
    env,
  })

  assert.equal(rejected.status, 403)
})

test('管理画面のCMS AIは会話履歴と追加入力UIを提供する', async () => {
  const source = await readFile(
    new URL('../public/admin/ai-panel.js', import.meta.url),
    'utf8',
  )

  assert.match(source, /AIと相談/)
  assert.match(source, /会話履歴/)
  assert.match(source, /\/messages/)
  assert.match(source, /hatt-cms-ai-conversation-id/)
  assert.match(
    source,
    /if \(isPending\(payload\.conversation\.status\)\) \{\s*if \(options\.schedulePolling !== false\)/,
  )
  assert.doesNotMatch(source, /hatt-cms-ai-job-id/)
})

test('CMS AI workflowは会話単位で直列化し既存branchとPull Requestを更新する', async () => {
  const [workflow, runner] = await Promise.all([
    readFile(
      new URL('../.github/workflows/cms-ai.yml', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../scripts/cms-ai-runner.mjs', import.meta.url), 'utf8'),
  ])

  assert.match(workflow, /client_payload\.conversation_id/)
  assert.match(
    workflow,
    /CMS_AI_JOB_ID: \$\{\{ github\.event\.client_payload\.job_id \}\}/,
  )
  assert.match(workflow, /node scripts\/cms-ai-runner\.mjs "\$CMS_AI_JOB_ID"/)
  assert.doesNotMatch(
    workflow,
    /node scripts\/cms-ai-runner\.mjs "\$\{\{ github\.event\.client_payload\.job_id \}\}"/,
  )
  assert.match(runner, /refs\/remotes\/origin\//)
  assert.match(runner, /origin\/main\.\.\.HEAD/)
  assert.match(runner, /'pr',\s*\n\s*'edit'/)
  assert.match(runner, /findAnyPullRequest/)
})

function createEnv({ ai, db } = {}) {
  return {
    AI: ai,
    CMS_ACCESS_ALLOWED_EMAILS: 'editor@example.com,other@example.com',
    CMS_ACCESS_AUD: accessAudience,
    CMS_ACCESS_TEAM_DOMAIN: accessIssuer,
    CMS_AI_DB: db,
    CMS_AI_GITHUB_OIDC_ISSUER: actionsIssuer,
    CMS_AI_RUNNER_AUDIENCE: actionsAudience,
    CMS_GITHUB_APP_CLIENT_ID: 'Iv23cmsaitest',
    CMS_GITHUB_APP_INSTALLATION_ID: '98765432',
    CMS_GITHUB_APP_PRIVATE_KEY: appPrivateKeyPem,
  }
}

function createDatabase() {
  const rows = new Map()

  return {
    rows,
    prepare(query) {
      let values = []

      return {
        bind(...nextValues) {
          values = nextValues
          return this
        },
        async first() {
          const id = values[0]
          const row = rows.get(id)

          if (!row) return null
          if (
            query.includes('requested_by = ?') &&
            row.requested_by !== values[1]
          ) {
            return null
          }

          return { ...row }
        },
        async all() {
          let result = Array.from(rows.values())

          if (query.includes('WHERE conversation_id = ?')) {
            const conversationId = values[0]
            const requestedBy = query.includes('requested_by = ?')
              ? values[1]
              : null
            result = result
              .filter(
                (row) =>
                  (row.conversation_id || row.id) === conversationId &&
                  (!requestedBy || row.requested_by === requestedBy),
              )
              .sort(
                (left, right) =>
                  Number(left.turn_number || 1) -
                    Number(right.turn_number || 1) ||
                  left.created_at.localeCompare(right.created_at),
              )
          } else if (query.includes('WHERE requested_by = ?')) {
            result = result
              .filter((row) => row.requested_by === values[0])
              .sort((left, right) =>
                right.created_at.localeCompare(left.created_at),
              )
              .slice(0, 200)
          }

          return { results: result.map((row) => ({ ...row })) }
        },
        async run() {
          if (query.startsWith('INSERT INTO cms_ai_jobs')) {
            const [
              id,
              conversationId,
              turnNumber,
              requestedBy,
              targetUrl,
              instruction,
              reasoningEffort,
              attachmentJson,
              status,
              branchName,
              assistantMessage,
              summary,
              clarification,
              prUrl,
              deploymentUrl,
              changedPathsJson,
              errorMessage,
              createdAt,
              updatedAt,
            ] = values
            rows.set(id, {
              assistant_message: assistantMessage,
              attachment_json: attachmentJson,
              branch_name: branchName,
              changed_paths_json: changedPathsJson,
              clarification,
              conversation_id: conversationId,
              created_at: createdAt,
              deployment_url: deploymentUrl,
              error_message: errorMessage,
              id,
              instruction,
              pr_url: prUrl,
              reasoning_effort: reasoningEffort,
              requested_by: requestedBy,
              status,
              summary,
              target_url: targetUrl,
              turn_number: turnNumber,
              updated_at: updatedAt,
            })
            return { meta: { changes: 1 } }
          }

          if (query.startsWith('UPDATE cms_ai_jobs')) {
            const [
              status,
              assistantMessage,
              summary,
              clarification,
              prUrl,
              deploymentUrl,
              changedPathsJson,
              errorMessage,
              updatedAt,
              id,
            ] = values
            const row = rows.get(id)

            if (row) {
              rows.set(id, {
                ...row,
                assistant_message: assistantMessage,
                changed_paths_json: changedPathsJson,
                clarification,
                deployment_url: deploymentUrl,
                error_message: errorMessage,
                pr_url: prUrl,
                status,
                summary,
                updated_at: updatedAt,
              })
            }
            return { meta: { changes: row ? 1 : 0 } }
          }

          if (query.startsWith('DELETE FROM cms_ai_jobs')) {
            rows.delete(values[0])
            return { meta: { changes: 1 } }
          }

          throw new Error('Unexpected D1 query: ' + query)
        },
      }
    },
  }
}

function mockFetch(handler) {
  globalThis.fetch = async (input, init = {}) => handler(String(input), init)
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installationTokenResponse() {
  return {
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    permissions: { contents: 'write', metadata: 'read' },
    repositories: [{ full_name: 'acecore-systems/homepage-hatt' }],
    token: 'cms-ai-installation-token',
  }
}

function signAccessJwt(email) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: accessKeyId })
    .setIssuer(accessIssuer)
    .setAudience(accessAudience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(accessPrivateKey)
}

function signActionsJwt({ repository = 'acecore-systems/homepage-hatt' } = {}) {
  return new SignJWT({
    event_name: 'repository_dispatch',
    ref: 'refs/heads/main',
    repository,
    run_id: '1234',
    workflow: 'CMS AI Automation',
  })
    .setProtectedHeader({ alg: 'RS256', kid: actionsKeyId })
    .setIssuer(actionsIssuer)
    .setAudience(actionsAudience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(actionsPrivateKey)
}

function validPngBytes() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
}
