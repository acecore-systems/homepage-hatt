import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createMarkdownProcessor } from '@astrojs/markdown-remark'
import sharp from 'sharp'

import { validateCmsFileContents } from '../functions/admin/api/_cms-content-validator.ts'
import { isAllowedCmsWritePath } from '../functions/admin/api/_cms-policy.ts'

const markdownRenderer = await createMarkdownProcessor()
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const rasterImagesPromise = createRasterImages()

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
  assertRejectedMarkdown('[click](java&#x09;script:alert(1))', /危険なURL/)
  assertRejectedMarkdown('[click](java&#13;script:alert(1))', /危険なURL/)
  assertRejectedMarkdown('[click](java&Tab;script:alert(1))', /危険なURL/)
  assertRejectedMarkdown('[click](data:text/html;base64,AAAA)', /危険なURL/)
})

test('escaped backtickでraw HTML検査を回避させない', () => {
  const unsafeHtml = '<img src=x onerror=alert(1)>'

  assertRejectedMarkdown(`\\\`${unsafeHtml}\\\``, /raw HTML/)
  assertRejectedMarkdown(`\\\`\`${unsafeHtml}\\\`\``, /raw HTML/)
  assertAcceptedMarkdown(`\`${unsafeHtml}\``)
  assertAcceptedMarkdown(`\`\`${unsafeHtml}\`\``)
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

test('backtickを含むinfo stringをfenceとして扱わない', async () => {
  const unsafeHtml = '<img src=x onerror=alert(1)>'
  const invalidOpenings = [
    { closing: '```', opening: '```bad`info' },
    { closing: '````', opening: '````bad`info' },
    { closing: '```', opening: '```bad\\`info' },
  ]

  for (const { closing, opening } of invalidOpenings) {
    const body = [opening, unsafeHtml, closing].join('\n')

    assertRejectedMarkdown(body, /raw HTML/)
    assert.match(await renderMarkdown(body), /<img\b[^>]*\bonerror=/i, opening)
  }
})

test('tabで4列目以降へ字下げした行をfence開始・終了として扱わない', async () => {
  const unsafeHtml = '<img src=x onerror=alert(1)>'

  for (let spaces = 0; spaces <= 3; spaces += 1) {
    const opening = ' '.repeat(spaces) + '\t```info'
    const body = [opening, unsafeHtml, '```'].join('\n')

    assertRejectedMarkdown(body, /raw HTML/)
    assert.match(await renderMarkdown(body), /<img\b[^>]*\bonerror=/i, opening)
  }

  const bodyWithTabbedClosing = ['```html', 'sample', '\t```', unsafeHtml].join(
    '\n',
  )

  assertAcceptedMarkdown(bodyWithTabbedClosing)
  assert.doesNotMatch(await renderMarkdown(bodyWithTabbedClosing), /<img\b/i)
})

test('3文字・4文字以上のbacktickとtilde fenceをrendererと同じく許可する', async () => {
  const unsafeHtml = '<img src=x onerror=alert(1)>'
  const validFences = [
    ['```html', unsafeHtml, '```'].join('\n'),
    ['````markdown', '```', unsafeHtml, '```', '````'].join('\n'),
    ['~~~text title=`sample`', unsafeHtml, '~~~'].join('\n'),
  ]

  for (const body of validFences) {
    assertAcceptedMarkdown(body)
    assert.doesNotMatch(await renderMarkdown(body), /<img\b/i)
  }
})

test('inline・reference形式の危険なhrefとsrcを拒否する', async () => {
  const cases = [
    {
      body: '[x](javascript\\:alert(1))',
      renderedPattern: /href="javascript:alert\(1\)"/i,
    },
    {
      body: ['[x][id]', '', '[id]: javascript:alert(1)'].join('\n'),
      renderedPattern: /href="javascript:alert\(1\)"/i,
    },
    {
      body: ['[x][id]', '', '[id]: java&#x73;cript\\:alert(1)'].join('\n'),
      renderedPattern: /href="javascript:alert\(1\)"/i,
    },
    {
      body: [
        '![x][asset]',
        '',
        '[asset]: data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      ].join('\n'),
      renderedPattern: /src="data:image\/svg\+xml;base64,/i,
    },
  ]

  for (const { body, renderedPattern } of cases) {
    assertRejectedMarkdown(body, /危険なURL/)
    assert.match(await renderMarkdown(body), renderedPattern)
  }
})

test('引用符内の感嘆符は許可しYAML aliasは拒否する', () => {
  assertAcceptedMarkdown('本文', "title: 'Example !!'")

  const result = validateCmsFileContents(
    'src/content/blog/example.md',
    Buffer.from(`${validFrontmatter('title: &shared Example')}\n本文\n`),
  )

  assert.equal(result.ok, false)
  assert.match(result.message, /許可されていないYAML構文/)
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

test('CMS mediaは許可対象5形式の実画像を受理する', async () => {
  for (const [extension, bytes] of Object.entries(await rasterImagesPromise)) {
    assert.deepEqual(
      validateCmsFileContents(`public/uploads/hatt/valid.${extension}`, bytes),
      { ok: true },
      extension,
    )
  }
})

test('CMS mediaはheader-onlyとtruncated dataを拒否する', async () => {
  const prefixLengths = {
    png: 8,
    jpg: 3,
    gif: 6,
    webp: 12,
    avif: 16,
  }

  for (const [extension, bytes] of Object.entries(await rasterImagesPromise)) {
    const path = `public/uploads/hatt/invalid.${extension}`

    assert.equal(
      validateCmsFileContents(path, bytes.subarray(0, prefixLengths[extension]))
        .ok,
      false,
      `${extension} header-only`,
    )
    assert.equal(
      validateCmsFileContents(path, bytes.subarray(0, bytes.byteLength - 1)).ok,
      false,
      `${extension} truncated`,
    )
  }
})

test('CMS mediaは宣言lengthと実データが一致しなければ拒否する', async () => {
  const images = await rasterImagesPromise
  const png = Buffer.from(images.png)
  png.writeUInt32BE(png.readUInt32BE(8) + 1, 8)

  const webp = Buffer.from(images.webp)
  webp.writeUInt32LE(webp.readUInt32LE(4) + 1, 4)

  const avif = Buffer.from(images.avif)
  avif.writeUInt32BE(avif.readUInt32BE(0) + 1, 0)

  const invalidImages = {
    png,
    jpg: Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x00, 0xff, 0xd9,
    ]),
    gif: Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x04, 0x00, 0x3b,
    ]),
    webp,
    avif,
  }

  for (const [extension, bytes] of Object.entries(invalidImages)) {
    assert.equal(
      validateCmsFileContents(`public/uploads/hatt/invalid.${extension}`, bytes)
        .ok,
      false,
      `${extension} length mismatch`,
    )
  }
})

test('CMS JSONは共有schemaと安全なURL制約に一致しなければ拒否する', () => {
  const campaign = {
    id: 'unsafe',
    enabled: true,
    kind: 'notice',
    placement: 'global',
    title: 'Unsafe',
  }

  assert.equal(
    validateCmsFileContents(
      'src/content/campaigns/unsafe.json',
      Buffer.from(JSON.stringify({ ...campaign, href: 'javascript:alert(1)' })),
    ).ok,
    false,
  )
  assert.equal(
    validateCmsFileContents(
      'src/content/campaigns/unsafe.json',
      Buffer.from(JSON.stringify({ ...campaign, placement: 'unknown' })),
    ).ok,
    false,
  )
  assert.equal(
    validateCmsFileContents(
      'src/content/campaigns/unsafe.json',
      Buffer.from(JSON.stringify({ ...campaign, unexpected: true })),
    ).ok,
    false,
  )
  assert.equal(
    validateCmsFileContents(
      'src/content/campaigns/different.json',
      Buffer.from(JSON.stringify(campaign)),
    ).ok,
    false,
  )
})

async function createRasterImages() {
  const source = () =>
    sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 24, g: 96, b: 160, alpha: 0.5 },
      },
    })
  const [png, jpg, gif, webp, avif] = await Promise.all([
    source().png().toBuffer(),
    source().jpeg({ progressive: true }).toBuffer(),
    source().gif().toBuffer(),
    source().webp().toBuffer(),
    source().avif().toBuffer(),
  ])

  return { png, jpg, gif, webp, avif }
}

function assertAcceptedMarkdown(body, title = 'title: Example') {
  assert.deepEqual(
    validateCmsFileContents(
      'src/content/blog/example.md',
      Buffer.from(`${validFrontmatter(title)}\n${body}\n`),
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

function validFrontmatter(title = 'title: Example') {
  return [
    '---',
    title,
    'description: Example description',
    'date: 2026-07-28T12:00+09:00',
    'author: hatt',
    '---',
  ].join('\n')
}

async function renderMarkdown(body) {
  const { code } = await markdownRenderer.render(body)

  return code
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
