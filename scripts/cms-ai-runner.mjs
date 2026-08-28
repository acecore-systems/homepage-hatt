import { execFile } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const jobId = process.argv[2] || ''
const repository = process.env.GITHUB_REPOSITORY || ''
const runnerUrl = String(process.env.CMS_AI_RUNNER_URL || '').replace(/\/$/, '')
const runnerAudience =
  process.env.CMS_AI_RUNNER_AUDIENCE ||
  'https://hatt.acecore.net/admin/api/ai/runner'
const workspace = process.cwd()
const maxContextBytes = 768 * 1024
const allowedExtensions = new Set([
  '.astro',
  '.css',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ts',
  '.tsx',
])

if (!/^[0-9a-f-]{36}$/i.test(jobId) || !runnerUrl || !repository) {
  throw new Error('CMS AI runnerの実行環境またはジョブIDが不正です。')
}

try {
  await main()
} catch (error) {
  await reportFailure(
    error instanceof Error ? error.message : 'CMS AI automation failed',
  )
  console.error(error)
  process.exitCode = 1
}

async function main() {
  const jobResponse = await runnerRequest('/jobs/' + encodeURIComponent(jobId))
  const job = jobResponse?.job

  if (!job || job.id !== jobId || typeof job.branchName !== 'string') {
    throw new Error('CMS AIジョブを読み取れません。')
  }

  if (job.status !== 'queued' && job.status !== 'running') {
    console.log('CMS AI job is already terminal:', job.status)
    return
  }

  await updateStatus({
    status: 'running',
    summary: 'AIが対象ページと関連ソースを確認しています。',
  })

  let validationFeedback = ''

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const sourceFiles = await collectSourceFiles(job)
    const inference = await runnerRequest('/inference', {
      body: {
        files: sourceFiles,
        jobId,
        ...(validationFeedback
          ? { validationFeedback: trimOutput(validationFeedback, 12_000) }
          : {}),
      },
      method: 'POST',
    })

    if (inference.status === 'needs_input') {
      console.log('CMS AI needs input:', inference.result?.clarification || '')
      return
    }

    const result = inference.result

    if (
      !result ||
      !Array.isArray(result.changes) ||
      result.changes.length === 0
    ) {
      throw new Error('CMS AIから変更案を受け取れませんでした。')
    }

    const originals = await applyChanges(result.changes)
    await updateStatus({
      changedPaths: result.changes.map((change) => change.path),
      status: 'validating',
      summary: result.summary || '変更を検証しています。',
    })

    const validation = await runValidation()

    if (validation.ok) {
      await createPullRequest(job, result)
      return
    }

    await restoreChanges(originals)
    validationFeedback = validation.output

    if (attempt < 3) {
      await updateStatus({
        status: 'running',
        summary: '検証結果をもとに、AIが変更案を再確認しています。',
      })
      continue
    }

    throw new Error(
      'AIの変更は3回の検証で通りませんでした。\n' +
        trimOutput(validation.output, 2_000),
    )
  }
}

async function collectSourceFiles(job) {
  const allPaths = await walkDirectory(workspace)
  const routeParts = new URL(job.targetUrl).pathname
    .split('/')
    .filter(Boolean)
    .map((part) => part.toLowerCase())
  const instructionWords = String(job.instruction || '')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((word) => word.length >= 3)
  const candidates = allPaths.filter(isContextPath).sort((left, right) => {
    return (
      scorePath(right, routeParts, instructionWords) -
        scorePath(left, routeParts, instructionWords) ||
      left.localeCompare(right)
    )
  })
  const files = []
  let totalBytes = 0

  for (const path of candidates) {
    const absolute = resolve(workspace, path)
    const content = await readFile(absolute, 'utf8').catch(() => null)

    if (content === null || content.includes('\u0000')) continue

    const bytes = Buffer.byteLength(content)

    if (bytes > 128 * 1024 || totalBytes + bytes > maxContextBytes) continue

    files.push({ content, path })
    totalBytes += bytes

    if (files.length >= 80) break
  }

  if (files.length === 0) {
    throw new Error('AIへ渡すサイトソースを見つけられませんでした。')
  }

  return files
}

async function walkDirectory(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = []

  for (const entry of entries) {
    const absolute = resolve(directory, entry.name)

    if (entry.isDirectory()) {
      const workspacePath = relative(workspace, absolute).replaceAll('\\', '/')

      if (
        workspacePath === '.git' ||
        workspacePath === 'dist' ||
        workspacePath === 'node_modules' ||
        workspacePath === '.astro' ||
        workspacePath === 'coverage'
      ) {
        continue
      }

      paths.push(...(await walkDirectory(root, absolute)))
      continue
    }

    if (entry.isFile()) {
      paths.push(relative(workspace, absolute).replaceAll('\\', '/'))
    }
  }

  return paths
}

function isContextPath(path) {
  const extension = extname(path).toLowerCase()

  if (!allowedExtensions.has(extension)) return false
  if (
    path.startsWith('public/admin/') ||
    path.startsWith('public/uploads/') ||
    path.startsWith('functions/admin/') ||
    path.startsWith('functions/api/shop/') ||
    path.startsWith('.github/') ||
    path.startsWith('migrations/') ||
    path.startsWith('scripts/') ||
    path.startsWith('tests/')
  ) {
    return false
  }

  return (
    path.startsWith('src/') ||
    path.startsWith('public/') ||
    path.startsWith('docs/')
  )
}

function scorePath(path, routeParts, instructionWords) {
  const lower = path.toLowerCase()
  let score = 0

  if (path.startsWith('src/pages/')) score += 20
  if (path.startsWith('src/components/')) score += 8
  if (path.startsWith('src/layouts/')) score += 8
  if (path.startsWith('src/styles/')) score += 6

  for (const part of routeParts) {
    if (lower.includes(part)) score += 50
  }
  for (const word of instructionWords) {
    if (lower.includes(word)) score += 10
  }

  return score
}

async function applyChanges(changes) {
  const originals = new Map()

  for (const change of changes) {
    if (
      !change ||
      typeof change.path !== 'string' ||
      typeof change.content !== 'string' ||
      !isWritablePath(change.path)
    ) {
      throw new Error('CMS AIの変更先が許可範囲外です。')
    }

    const absolute = resolveWorkspacePath(change.path)
    const original = await readFile(absolute, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return null
      throw error
    })

    originals.set(change.path, original)
    await writeFile(absolute, change.content, 'utf8')
  }

  return originals
}

async function restoreChanges(originals) {
  for (const [path, original] of originals) {
    if (original === null) {
      throw new Error(
        'AIが新規ファイルを作成したため、自動再試行では安全に戻せません。',
      )
    }

    await writeFile(resolveWorkspacePath(path), original, 'utf8')
  }
}

async function runValidation() {
  const commands = [
    ['npm', ['run', 'format:check']],
    ['npm', ['run', 'validate:content']],
    ['npm', ['run', 'test:cms']],
    ['npm', ['run', 'typecheck:functions']],
    ['npm', ['run', 'build']],
  ]
  const output = []

  for (const [command, args] of commands) {
    const result = await runCommand(command, args)
    output.push('$ ' + command + ' ' + args.join(' ') + '\n' + result.output)

    if (!result.ok) {
      return {
        ok: false,
        output: trimOutput(output.join('\n\n'), 16_000),
      }
    }
  }

  return {
    ok: true,
    output: trimOutput(output.join('\n\n'), 4_000),
  }
}

async function createPullRequest(job, result) {
  const changedPaths = await getChangedPaths()

  if (changedPaths.length === 0) {
    throw new Error('検証後にコミットする変更がありません。')
  }

  if (changedPaths.some((path) => !isWritablePath(path))) {
    throw new Error('許可範囲外の変更が検出されたため停止しました。')
  }

  await runRequired('git', ['switch', '-c', job.branchName])
  await runRequired('git', ['config', 'user.name', 'github-actions[bot]'])
  await runRequired('git', [
    'config',
    'user.email',
    '41898282+github-actions[bot]@users.noreply.github.com',
  ])
  await runRequired('git', ['add', '--', ...changedPaths])
  await runRequired('git', ['commit', '-m', 'cms: AI request ' + job.id])
  const commitSha = (await runRequired('git', ['rev-parse', 'HEAD'])).trim()
  await runRequired('git', [
    'push',
    'origin',
    'HEAD:refs/heads/' + job.branchName,
  ])

  const prBody = [
    '## 概要',
    '',
    result.summary || 'CMS AIによるサイト修正です。',
    '',
    '## 対象',
    '',
    '- ' + job.targetUrl,
    '',
    '## 変更ファイル',
    '',
    ...changedPaths.map((path) => '- ' + path),
    '',
    '## 自動確認',
    '',
    '- format:check',
    '- validate:content',
    '- test:cms',
    '- typecheck:functions',
    '- build',
    '',
    'このPRはCMS AI Automation workflowによって作成されました。',
  ].join('\n')
  const prOutput = await runRequired('gh', [
    'pr',
    'create',
    '--repo',
    repository,
    '--base',
    'main',
    '--head',
    job.branchName,
    '--title',
    'CMS AI: ' + trimOneLine(result.summary || 'サイト修正', 80),
    '--body',
    prBody,
  ])
  const prUrl = findPullRequestUrl(prOutput)

  await updateStatus({
    changedPaths,
    prUrl,
    status: 'pr_created',
    summary: 'Pull Requestを作成し、CIを待っています。',
  })

  if (!job.autoMergeEnabled) {
    console.log('CMS AI auto merge is disabled; leaving PR open:', prUrl)
    return
  }

  await runRequired('gh', [
    'workflow',
    'run',
    'ci.yml',
    '--repo',
    repository,
    '--ref',
    job.branchName,
  ])
  const ciRunId = await waitForCiRun(job.branchName, commitSha)
  await runRequired('gh', [
    'run',
    'watch',
    ciRunId,
    '--repo',
    repository,
    '--exit-status',
  ])
  await runRequired('gh', [
    'pr',
    'merge',
    prUrl,
    '--repo',
    repository,
    '--squash',
    '--match-head-commit',
    commitSha,
  ])
  await updateStatus({
    changedPaths,
    prUrl,
    status: 'merged',
    summary:
      'CIが成功し、mainへマージしました。Cloudflare PagesのGitHub連携デプロイを待っています。',
  })
}

async function getChangedPaths() {
  const tracked = await runRequired('git', ['diff', '--name-only'])
  const untracked = await runRequired('git', [
    'ls-files',
    '--others',
    '--exclude-standard',
  ])

  return Array.from(
    new Set(
      (tracked + '\n' + untracked)
        .split(/\r?\n/)
        .map((path) => path.trim().replaceAll('\\', '/'))
        .filter(Boolean),
    ),
  )
}

async function waitForCiRun(branchName, commitSha) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await runCommand('gh', [
      'run',
      'list',
      '--repo',
      repository,
      '--workflow',
      'ci.yml',
      '--branch',
      branchName,
      '--commit',
      commitSha,
      '--event',
      'workflow_dispatch',
      '--limit',
      '1',
      '--json',
      'databaseId',
      '--jq',
      '.[0].databaseId // empty',
    ])
    const runId = result.output.trim()

    if (result.ok && runId) return runId

    await delay(2_000)
  }

  throw new Error('明示起動したCIを見つけられませんでした。')
}

async function updateStatus(body) {
  await runnerRequest('/jobs/' + encodeURIComponent(jobId) + '/status', {
    body,
    method: 'POST',
  })
}

async function reportFailure(message) {
  if (!runnerUrl || !/^[0-9a-f-]{36}$/i.test(jobId)) return

  try {
    await updateStatus({
      errorMessage: trimOutput(message, 2_000),
      status: 'failed',
      summary: '自動処理を停止しました。',
    })
  } catch {
    // 失敗通知の失敗で元の原因を隠さない。
  }
}

async function runnerRequest(path, { body, method = 'GET' } = {}) {
  const token = await getOidcToken()
  const response = await fetch(runnerUrl + path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    method,
  })
  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(
      typeof payload.message === 'string'
        ? payload.message
        : 'CMS AI runnerとの通信に失敗しました。',
    )
  }

  return payload
}

async function getOidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN

  if (!requestUrl || !requestToken) {
    throw new Error('GitHub Actions OIDC tokenを取得できません。')
  }

  const url = new URL(requestUrl)
  url.searchParams.set('audience', runnerAudience)
  const response = await fetch(url, {
    headers: { Authorization: 'Bearer ' + requestToken },
  })
  const payload = await response.json().catch(() => ({}))

  if (!response.ok || typeof payload.value !== 'string' || !payload.value) {
    throw new Error('GitHub Actions OIDC tokenを取得できません。')
  }

  return payload.value
}

async function runRequired(command, args) {
  const result = await runCommand(command, args)

  if (!result.ok) {
    throw new Error(
      '$ ' + command + ' ' + args.join(' ') + '\n' + result.output,
    )
  }

  return result.output
}

async function runCommand(command, args) {
  try {
    const { stderr, stdout } = await execFileAsync(command, args, {
      cwd: workspace,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    })

    return {
      ok: true,
      output: trimOutput(String(stdout) + String(stderr), 32_000),
    }
  } catch (error) {
    return {
      ok: false,
      output: trimOutput(
        String(error?.stdout || '') +
          String(error?.stderr || error?.message || ''),
        32_000,
      ),
    }
  }
}

function resolveWorkspacePath(path) {
  const absolute = resolve(workspace, path)
  const relativePath = relative(workspace, absolute)

  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith('..' + sep)
  ) {
    throw new Error('CMS AIの変更先がworkspace外です。')
  }

  return absolute
}

function isWritablePath(path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '')
  const parts = normalized.split('/')
  const extension = extname(normalized).toLowerCase()

  if (
    !normalized ||
    normalized.length > 240 ||
    parts.some((part) => !part || part === '.' || part === '..') ||
    !allowedExtensions.has(extension)
  ) {
    return false
  }

  if (
    normalized.startsWith('public/admin/') ||
    normalized.startsWith('public/uploads/') ||
    normalized.startsWith('functions/') ||
    normalized.startsWith('.github/') ||
    normalized.startsWith('migrations/') ||
    normalized.startsWith('scripts/') ||
    normalized.startsWith('tests/')
  ) {
    return false
  }

  return (
    normalized.startsWith('src/') ||
    normalized.startsWith('public/') ||
    normalized.startsWith('docs/')
  )
}

function findPullRequestUrl(value) {
  const match = String(value).match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)

  if (!match) {
    throw new Error('作成したPull RequestのURLを確認できません。')
  }

  return match[0]
}

function trimOutput(value, maxLength) {
  const text = String(value).trim()

  return text.length <= maxLength ? text : text.slice(-maxLength)
}

function trimOneLine(value, maxLength) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  )
}
