import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateCmsFileContents } from '../functions/admin/api/_cms-content-validator.ts'
import { isAllowedCmsWritePath } from '../functions/admin/api/_cms-policy.ts'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

test('現在のCMS管理コンテンツとmediaをすべてruntime schemaで検証できる', async () => {
  const roots = ['src/content', 'public/uploads/hatt']
  let validated = 0

  for (const root of roots) {
    for (const relativePath of await listFiles(root)) {
      assert.equal(
        isAllowedCmsWritePath(relativePath),
        true,
        `${relativePath} is not covered by CMS write policy`,
      )

      const result = validateCmsFileContents(
        relativePath,
        await readFile(path.join(repositoryRoot, relativePath)),
      )

      assert.deepEqual(result, { ok: true }, result.message)
      validated += 1
    }
  }

  assert.ok(validated > 200)
})

test('Markdownのraw HTMLと危険なURL schemeを拒否する', () => {
  assertRejectedMarkdown('<img src=x onerror=alert(1)>', /raw HTML/)
  assertRejectedMarkdown('[click](java&#x73;cript:alert(1))', /危険なURL/)
  assertRejectedMarkdown('[click](data:text/html;base64,AAAA)', /危険なURL/)
})

test('同じ記号・長さを満たすfenceだけをcode block終端として扱う', () => {
  assertAcceptedMarkdown(
    [
      '~~~~html',
      '<img src=x onerror=alert(1)>',
      '```',
      '<script>alert(1)</script>',
      '~~~~',
    ].join('\n'),
  )

  assertRejectedMarkdown(
    [
      '~~~~html',
      '<span>code sample</span>',
      '~~~~',
      '<img src=x onerror=alert(1)>',
    ].join('\n'),
    /raw HTML/,
  )
})

test('CMS mediaはraster実体だけを許可しSVGとPDFを対象外にする', () => {
  assert.equal(isAllowedCmsWritePath('public/uploads/hatt/vector.svg'), false)
  assert.equal(isAllowedCmsWritePath('public/uploads/hatt/document.pdf'), false)

  assert.deepEqual(
    validateCmsFileContents(
      'public/uploads/hatt/fake.png',
      Buffer.from('<script>alert(1)</script>'),
    ),
    {
      ok: false,
      message:
        'public/uploads/hatt/fake.png: 拡張子と画像データの形式が一致しません。',
    },
  )
})

test('CMS JSONは共有schemaと安全なURL制約に一致しなければ拒否する', () => {
  const unsafe = Buffer.from(
    JSON.stringify({
      id: 'unsafe',
      enabled: true,
      kind: 'notice',
      placement: 'global',
      title: 'Unsafe',
      href: 'javascript:alert(1)',
    }),
  )

  assert.equal(
    validateCmsFileContents('src/content/campaigns/unsafe.json', unsafe).ok,
    false,
  )
})

function assertAcceptedMarkdown(body) {
  assert.deepEqual(
    validateCmsFileContents(
      'src/content/blog/example.md',
      Buffer.from(`${validFrontmatter()}\n${body}\n`),
    ),
    { ok: true },
  )
}

function assertRejectedMarkdown(body, pattern) {
  const result = validateCmsFileContents(
    'src/content/blog/example.md',
    Buffer.from(`${validFrontmatter()}\n${body}\n`),
  )

  assert.equal(result.ok, false)
  assert.match(result.message, pattern)
}

function validFrontmatter() {
  return [
    '---',
    'title: Example',
    'description: Example description',
    'date: 2026-07-28T12:00+09:00',
    'author: hatt',
    '---',
  ].join('\n')
}

async function listFiles(root) {
  const absoluteRoot = path.join(repositoryRoot, root)
  const entries = await readdir(absoluteRoot, {
    recursive: true,
    withFileTypes: true,
  })

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(repositoryRoot, path.join(entry.parentPath, entry.name))
        .replaceAll(path.sep, '/'),
    )
    .sort()
}
