import { spawn } from 'node:child_process'
import { createPrivateKey, randomBytes, sign as signBytes } from 'node:crypto'
import { access } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GITHUB_API_VERSION = '2022-11-28'
const SETUP_TIMEOUT_MS = 55 * 60 * 1000
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function parseOptions(args) {
  const options = { open: true }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === '--no-open') {
      options.open = false
      continue
    }

    if (!argument.startsWith('--')) {
      throw new Error(`不明な引数です: ${argument}`)
    }

    const key = argument
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    const value = args[index + 1]

    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} の値がありません。`)
    }

    options[key] = value
    index += 1
  }

  for (const name of ['owner', 'repo', 'appName', 'siteUrl', 'pagesProject']) {
    if (!options[name]) throw new Error(`--${toKebabCase(name)} は必須です。`)
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(options.owner)) {
    throw new Error('--owner が不正です。')
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(options.repo)) {
    throw new Error('--repo が不正です。')
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(options.pagesProject)) {
    throw new Error('--pages-project が不正です。')
  }

  const siteUrl = new URL(options.siteUrl)

  if (siteUrl.protocol !== 'https:') {
    throw new Error('--site-url は https URL にしてください。')
  }

  options.siteUrl = siteUrl.origin
  return options
}

export function buildGithubAppManifest(options, callbackBaseUrl) {
  return {
    name: options.appName,
    url: options.siteUrl,
    description: `Cloudflare Access protected Sveltia CMS writer for ${options.owner}/${options.repo}`,
    redirect_url: `${callbackBaseUrl}/github-app/callback`,
    setup_url: `${callbackBaseUrl}/github-app/installed`,
    setup_on_update: false,
    public: false,
    request_oauth_on_install: false,
    hook_attributes: {
      url: options.siteUrl,
      active: false,
    },
    default_events: [],
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
    },
  }
}

export function convertPrivateKeyToPkcs8(pem) {
  return createPrivateKey(pem)
    .export({ format: 'pem', type: 'pkcs8' })
    .toString()
}

export function validateInstallationScope(
  installation,
  repositories,
  { owner, repo },
) {
  const accountLogin = installation?.account?.login
  const permissions = installation?.permissions || {}
  const permissionNames = Object.keys(permissions)

  if (
    accountLogin?.toLowerCase() !== owner.toLowerCase() ||
    installation?.account?.type !== 'Organization' ||
    installation?.repository_selection !== 'selected'
  ) {
    throw new Error(
      `GitHub App は ${owner} の Only select repositories でインストールしてください。`,
    )
  }

  if (
    permissions.contents !== 'write' ||
    permissions.pull_requests !== 'write' ||
    permissions.metadata !== 'read' ||
    permissionNames.some(
      (name) => !['contents', 'metadata', 'pull_requests'].includes(name),
    )
  ) {
    throw new Error(
      'GitHub App の権限は Contents / Pull requests の write と Metadata の read だけにしてください。',
    )
  }

  const expected = `${owner}/${repo}`.toLowerCase()
  const installed = Array.isArray(repositories?.repositories)
    ? repositories.repositories.map((item) => item?.full_name?.toLowerCase())
    : []

  if (
    repositories?.total_count !== 1 ||
    installed.length !== 1 ||
    installed[0] !== expected
  ) {
    throw new Error(
      `Repository access は ${owner}/${repo} だけを選択してください。`,
    )
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const state = randomBytes(32).toString('hex')
  let appCredentials = null
  let setupStatus = {
    state: 'waiting',
    message: 'GitHub App の作成を待っています。',
  }
  let shutdownTimer
  const setupTimeout = setTimeout(() => {
    setupStatus = {
      state: 'error',
      message:
        'セットアップの有効時間が終了しました。もう一度実行してください。',
    }
    appCredentials = null
    process.exitCode = 1
    server.close()
  }, SETUP_TIMEOUT_MS)

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')

    try {
      if (requestUrl.pathname === '/') {
        const callbackBaseUrl = `http://127.0.0.1:${server.address().port}`
        const manifest = buildGithubAppManifest(options, callbackBaseUrl)
        const action = `https://github.com/organizations/${encodeURIComponent(options.owner)}/settings/apps/new?state=${state}`

        return sendHtml(
          response,
          page(
            'CMS GitHub App セットアップ',
            `<p><code>${escapeHtml(`${options.owner}/${options.repo}`)}</code> 専用 App を作成します。</p>
             <form id="github-app-manifest" action="${escapeHtml(action)}" method="post">
               <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
               <button type="submit">GitHub で App を作成</button>
             </form>
             <p>GitHub では App 名を確認し、インストール先に <strong>${escapeHtml(options.repo)}</strong> だけを選択してください。</p>
             <script>
               const key = 'cms-github-app-manifest-${state}';
               if (!sessionStorage.getItem(key)) {
                 sessionStorage.setItem(key, 'submitted');
                 document.querySelector('#github-app-manifest').requestSubmit();
               }
             </script>`,
          ),
        )
      }

      if (requestUrl.pathname === '/github-app/callback') {
        if (requestUrl.searchParams.get('state') !== state) {
          return sendHtml(
            response,
            errorPage('state の検証に失敗しました。'),
            400,
          )
        }

        const code = requestUrl.searchParams.get('code')

        if (!code) {
          return sendHtml(
            response,
            errorPage('GitHub の code がありません。'),
            400,
          )
        }

        const conversion = await githubJson(
          `/app-manifests/${encodeURIComponent(code)}/conversions`,
          { method: 'POST' },
        )

        if (
          typeof conversion.client_id !== 'string' ||
          typeof conversion.pem !== 'string' ||
          typeof conversion.slug !== 'string'
        ) {
          throw new Error('GitHub App の作成結果が不正です。')
        }

        appCredentials = {
          clientId: conversion.client_id,
          privateKey: convertPrivateKeyToPkcs8(conversion.pem),
          slug: conversion.slug,
        }
        setupStatus = {
          state: 'waiting',
          message: 'GitHub App のインストールを待っています。',
        }

        response.writeHead(302, {
          Location: `https://github.com/apps/${encodeURIComponent(conversion.slug)}/installations/new`,
        })
        response.end()
        return
      }

      if (requestUrl.pathname === '/github-app/installed') {
        const installationId = requestUrl.searchParams.get('installation_id')

        if (
          !appCredentials ||
          !installationId ||
          !/^\d+$/.test(installationId)
        ) {
          return sendHtml(
            response,
            errorPage('GitHub App のインストール情報を確認できません。'),
            400,
          )
        }

        if (setupStatus.state !== 'running') {
          setupStatus = {
            state: 'running',
            message: '権限を検証し、Cloudflare Pages に設定しています。',
          }
          finishSetup({ appCredentials, installationId, options })
            .then(() => {
              clearTimeout(setupTimeout)
              setupStatus = {
                state: 'complete',
                message:
                  'Production / preview の GitHub App 設定が完了しました。このタブを閉じて構いません。',
              }
              appCredentials = null
              shutdownTimer = setTimeout(() => server.close(), 5000)
            })
            .catch((error) => {
              clearTimeout(setupTimeout)
              setupStatus = {
                state: 'error',
                message:
                  error instanceof Error
                    ? error.message
                    : 'セットアップに失敗しました。',
              }
              appCredentials = null
              process.exitCode = 1
              shutdownTimer = setTimeout(() => server.close(), 15000)
            })
        }

        return sendHtml(
          response,
          statusPage(`${options.owner}/${options.repo}`),
        )
      }

      if (requestUrl.pathname === '/status') {
        return sendJson(response, setupStatus)
      }

      sendHtml(response, errorPage('ページが見つかりません。'), 404)
    } catch (error) {
      clearTimeout(setupTimeout)
      const message =
        error instanceof Error ? error.message : 'セットアップに失敗しました。'
      setupStatus = { state: 'error', message }
      process.exitCode = 1
      sendHtml(response, errorPage(message), 500)
      shutdownTimer = setTimeout(() => server.close(), 15000)
    }
  })

  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`

    console.log(`CMS GitHub App setup: ${url}`)
    console.log('秘密鍵はメモリ内で処理し、ファイルには保存しません。')

    if (options.open) openBrowser(url)
  })

  process.once('SIGINT', () => {
    clearTimeout(setupTimeout)
    if (shutdownTimer) clearTimeout(shutdownTimer)
    server.close()
  })
}

async function finishSetup({ appCredentials, installationId, options }) {
  const appJwt = createAppJwt(
    appCredentials.clientId,
    appCredentials.privateKey,
  )
  const installation = await githubJson(
    `/app/installations/${installationId}`,
    {
      token: appJwt,
    },
  )
  const tokenResult = await githubJson(
    `/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      token: appJwt,
      body: {
        permissions: {
          contents: 'read',
          pull_requests: 'read',
        },
      },
    },
  )

  if (typeof tokenResult.token !== 'string') {
    throw new Error('GitHub installation token を検証できません。')
  }

  const repositories = await githubJson(
    '/installation/repositories?per_page=100',
    {
      token: tokenResult.token,
    },
  )

  validateInstallationScope(installation, repositories, options)

  const secrets = {
    CMS_GITHUB_APP_CLIENT_ID: appCredentials.clientId,
    CMS_GITHUB_APP_INSTALLATION_ID: installationId,
    CMS_GITHUB_APP_PRIVATE_KEY: appCredentials.privateKey,
  }

  for (const environment of ['production', 'preview']) {
    for (const [name, value] of Object.entries(secrets)) {
      await putPagesSecret({
        environment,
        name,
        pagesProject: options.pagesProject,
        value,
      })
    }
  }
}

function createAppJwt(clientId, privateKey) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64Url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: clientId }),
  )
  const signingInput = `${header}.${payload}`
  const signature = signBytes(
    'RSA-SHA256',
    Buffer.from(signingInput),
    createPrivateKey(privateKey),
  ).toString('base64url')

  return `${signingInput}.${signature}`
}

async function githubJson(apiPath, { body, method = 'GET', token } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'acecore-cms-github-app-setup',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  }

  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      data && typeof data.message === 'string'
        ? data.message
        : `GitHub API error (${response.status})`
    throw new Error(message)
  }

  return data
}

async function putPagesSecret({ environment, name, pagesProject, value }) {
  const wrangler = path.join(
    root,
    'node_modules',
    'wrangler',
    'bin',
    'wrangler.js',
  )

  await access(wrangler).catch(() => {
    throw new Error('先に npm ci または npm install を実行してください。')
  })

  const args = [
    wrangler,
    'pages',
    'secret',
    'put',
    name,
    '--project-name',
    pagesProject,
  ]

  if (environment === 'preview') args.push('--env', 'preview')

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''

    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        console.log(`Configured ${name} (${environment})`)
        resolve()
      } else {
        reject(
          new Error(
            `Cloudflare Pages の ${name} (${environment}) 設定に失敗しました。\n${output.trim()}`,
          ),
        )
      }
    })
    child.stdin.end(`${value}\n`)
  })
}

function openBrowser(url) {
  const commands = {
    darwin: ['open', [url]],
    linux: ['xdg-open', [url]],
    win32: ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
  }
  const [command, args] = commands[process.platform] || commands.linux
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })

  child.once('error', () => {
    console.warn(
      'ブラウザを自動で開けませんでした。表示したURLを開いてください。',
    )
  })
  child.unref()
}

function statusPage(repository) {
  return page(
    'CMS GitHub App セットアップ',
    `<p><code>${escapeHtml(repository)}</code></p>
     <p id="status">Cloudflare Pages に設定しています。</p>
     <script>
       const timer = setInterval(async () => {
         try {
           const response = await fetch('/status', { cache: 'no-store' });
           const result = await response.json();
           document.querySelector('#status').textContent = result.message;
           if (result.state === 'complete' || result.state === 'error') clearInterval(timer);
         } catch {}
       }, 1000);
     </script>`,
  )
}

function page(title, content) {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body { max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem; color: #17202a; font: 16px/1.7 system-ui, sans-serif; }
      button { border: 0; border-radius: 6px; padding: .75rem 1rem; background: #1f6feb; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
      code { overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    ${content}
  </body>
</html>`
}

function errorPage(message) {
  return page('セットアップエラー', `<p>${escapeHtml(message)}</p>`)
}

function sendHtml(response, body, status = 200) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function sendJson(response, body) {
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function isMainModule() {
  if (!process.argv[1]) return false

  const current = fileURLToPath(import.meta.url)
  const entry = path.resolve(process.argv[1])

  return process.platform === 'win32'
    ? current.toLowerCase() === entry.toLowerCase()
    : current === entry
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
