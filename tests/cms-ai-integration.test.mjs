import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('CMS AIは共通会話UIとService Bindingだけをサイトへ組み込む', async () => {
  const [admin, client, style, adapter, config, workflow] = await Promise.all([
    read('public/admin/index.html'),
    read('public/admin/ai-panel.js'),
    read('public/admin/ai-panel.css'),
    read('functions/admin/api/ai/[[path]].ts'),
    read('wrangler.jsonc'),
    read('.github/workflows/cms-ai.yml'),
  ])

  assert.match(admin, /\/admin\/ai-panel\.css/)
  assert.match(admin, /\/admin\/ai-panel\.js/)
  assert.match(client, /\/admin\/api\/ai/)
  assert.match(client, /sessionEndpoint/)
  assert.match(client, /reasoningEffort/)
  assert.match(client, /cms-ai-image-input/)
  assert.match(client, /revokeObjectURL/)
  assert.match(client, /\/messages/)
  assert.match(client, /session\?\.role/)
  assert.doesNotMatch(client, /targetUrl|referenceImage/)
  assert.match(style, /@media \(max-width: 40rem\)[\s\S]*?font-size: 1rem/)
  assert.match(adapter, /CMS_AI\.fetch\(request\)/)
  assert.doesNotMatch(adapter, /AI\.run|CMS_AI_MODEL|GITHUB_TOKEN/)
  assert.match(config, /"binding":\s*"CMS_AI"[\s\S]*?"service":\s*"cms-ai"/)
  assert.doesNotMatch(
    config,
    /"binding":\s*"CMS_AI_DB"|"ai":\s*\{|CMS_AI_MODEL|CMS_AI_RUNNER_AUDIENCE|CMS_AI_TARGET_HOSTNAMES/,
  )
  assert.match(workflow, /workflow_dispatch:/)
  assert.doesNotMatch(workflow, /repository_dispatch:/)
  assert.match(workflow, /contents: write/)
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /pull-requests: write/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /timeout-minutes: 45/)
  assert.match(workflow, /acecore-systems\/cms-ai\/runner@v1/)
  assert.doesNotMatch(workflow, /pr merge|auto.?merge/i)
})
