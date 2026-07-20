import assert from 'node:assert/strict'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import {
  buildGithubAppManifest,
  convertPrivateKeyToPkcs8,
  parseOptions,
  validateInstallationScope,
} from '../scripts/setup-cms-github-app.mjs'

const options = {
  appName: 'Acecore Hatt CMS',
  open: true,
  owner: 'acecore-systems',
  pagesProject: 'homepage-hatt',
  repo: 'homepage-hatt',
  siteUrl: 'https://hatt.acecore.net',
}

test('セットアップに必要なWranglerを開発依存関係として固定する', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )

  assert.match(packageJson.devDependencies?.wrangler ?? '', /^\^4\./)
})

test('GitHub App manifestは最小権限かつwebhook無効で生成する', () => {
  const manifest = buildGithubAppManifest(options, 'http://127.0.0.1:12345')

  assert.equal(manifest.public, false)
  assert.equal(manifest.request_oauth_on_install, false)
  assert.deepEqual(manifest.default_events, [])
  assert.deepEqual(manifest.default_permissions, {
    contents: 'write',
    pull_requests: 'write',
  })
  assert.deepEqual(manifest.hook_attributes, {
    active: false,
    url: 'https://hatt.acecore.net',
  })
  assert.equal(
    manifest.redirect_url,
    'http://127.0.0.1:12345/github-app/callback',
  )
  assert.equal(
    manifest.setup_url,
    'http://127.0.0.1:12345/github-app/installed',
  )
})

test('セットアップ引数を検証して正規化する', () => {
  assert.deepEqual(
    parseOptions([
      '--owner',
      'acecore-systems',
      '--repo',
      'homepage-hatt',
      '--app-name',
      'Acecore Hatt CMS',
      '--site-url',
      'https://hatt.acecore.net/admin/',
      '--pages-project',
      'homepage-hatt',
      '--no-open',
    ]),
    { ...options, open: false },
  )
})

test('GitHub Appのインストール先を対象repositoryだけに制限する', () => {
  const installation = {
    account: { login: 'acecore-systems', type: 'Organization' },
    permissions: {
      contents: 'write',
      metadata: 'read',
      pull_requests: 'write',
    },
    repository_selection: 'selected',
  }
  const repositories = {
    total_count: 1,
    repositories: [{ full_name: 'acecore-systems/homepage-hatt' }],
  }

  assert.doesNotThrow(() =>
    validateInstallationScope(installation, repositories, options),
  )
  assert.throws(
    () =>
      validateInstallationScope(
        installation,
        {
          total_count: 2,
          repositories: [
            ...repositories.repositories,
            { full_name: 'acecore-systems/homepage-cherry' },
          ],
        },
        options,
      ),
    /homepage-hatt だけ/,
  )
  assert.throws(
    () =>
      validateInstallationScope(
        {
          ...installation,
          permissions: { ...installation.permissions, issues: 'write' },
        },
        repositories,
        options,
      ),
    /Contents \/ Pull requests/,
  )
})

test('GitHubのPKCS#1秘密鍵をCloudflare用PKCS#8へ変換する', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs1' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  })
  const converted = convertPrivateKeyToPkcs8(privateKey)

  assert.match(converted, /^-----BEGIN PRIVATE KEY-----/)
  assert.doesNotThrow(() => createPrivateKey(converted))
})
