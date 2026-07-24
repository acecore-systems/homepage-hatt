import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { getGitLastModifiedDate } from '../scripts/sitemap-lastmod.mjs'

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function commit(cwd, message, date) {
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  })
}

test('uses the latest commit that actually changed the mapped content', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hatt-sitemap-full-'))

  try {
    git(root, ['init', '--initial-branch=main'])
    git(root, ['config', 'user.name', 'Sitemap Test'])
    git(root, ['config', 'user.email', 'sitemap@example.invalid'])

    writeFileSync(path.join(root, 'content.txt'), 'content\n')
    commit(root, 'Add content', '2024-01-02T03:04:05Z')
    writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated\n')
    commit(root, 'Change unrelated file', '2024-02-03T04:05:06Z')

    assert.equal(getGitLastModifiedDate(['content.txt'], root), '2024-01-02')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('omits an unknown date in a shallow checkout instead of using build time', () => {
  const source = mkdtempSync(path.join(tmpdir(), 'hatt-sitemap-source-'))
  const shallowParent = mkdtempSync(
    path.join(tmpdir(), 'hatt-sitemap-shallow-'),
  )
  const shallow = path.join(shallowParent, 'repo')

  try {
    git(source, ['init', '--initial-branch=main'])
    git(source, ['config', 'user.name', 'Sitemap Test'])
    git(source, ['config', 'user.email', 'sitemap@example.invalid'])

    writeFileSync(path.join(source, 'content.txt'), 'content\n')
    commit(source, 'Add content', '2024-01-02T03:04:05Z')
    writeFileSync(path.join(source, 'unrelated.txt'), 'unrelated\n')
    commit(source, 'Change unrelated file', '2024-02-03T04:05:06Z')

    git(shallowParent, [
      'clone',
      '--depth=1',
      pathToFileURL(source).href,
      shallow,
    ])

    assert.equal(getGitLastModifiedDate(['content.txt'], shallow), undefined)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(shallowParent, { recursive: true, force: true })
  }
})
