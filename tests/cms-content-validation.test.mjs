import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createMarkdownProcessor } from '@astrojs/markdown-remark'
import sharp from 'sharp'
import { deflateSync } from 'node:zlib'

import {
  MAX_CMS_TEXT_FILE_BYTES,
  validateCmsFileContents,
} from '../functions/admin/api/_cms-content-validator.ts'
import { isAllowedCmsWritePath } from '../functions/admin/api/_cms-policy.ts'
import { contentRouteSlugSchema } from '../src/content-schemas.ts'

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

      const result = await validateCmsFileContents(
        relativePath,
        await readFile(path.join(repositoryRoot, relativePath)),
      )

      assert.deepEqual(result, { ok: true }, result.message)
      validated += 1
    }
  }

  assert.ok(validated > 200)
})

test('Markdownのraw HTMLと危険なURL schemeを拒否する', async () => {
  await assertRejectedMarkdown('<img src=x onerror=alert(1)>', /raw HTML/)
  await assertRejectedMarkdown('[click](java&#x73;cript:alert(1))', /危険なURL/)
  await assertRejectedMarkdown(
    '[click](java&#x09;script:alert(1))',
    /危険なURL/,
  )
  await assertRejectedMarkdown('[click](java&#13;script:alert(1))', /危険なURL/)
  await assertRejectedMarkdown('[click](java&Tab;script:alert(1))', /危険なURL/)
  await assertRejectedMarkdown(
    '[click](data:text/html;base64,AAAA)',
    /危険なURL/,
  )
})

test('escaped backtickでraw HTML検査を回避させない', async () => {
  const unsafeHtml = '<img src=x onerror=alert(1)>'

  await assertRejectedMarkdown(`\\\`${unsafeHtml}\\\``, /raw HTML/)
  await assertRejectedMarkdown(`\\\`\`${unsafeHtml}\\\`\``, /raw HTML/)
  await assertAcceptedMarkdown(`\`${unsafeHtml}\``)
  await assertAcceptedMarkdown(`\`\`${unsafeHtml}\`\``)
})

test('同じ記号・長さを満たすfenceだけをcode block終端として扱う', async () => {
  await assertAcceptedMarkdown(
    [
      '~~~~html',
      '<img src=x onerror=alert(1)>',
      '```',
      '<script>alert(1)</script>',
      '~~~~',
    ].join('\n'),
  )

  await assertRejectedMarkdown(
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

    await assertRejectedMarkdown(body, /raw HTML/)
    assert.match(await renderMarkdown(body), /<img\b[^>]*\bonerror=/i, opening)
  }
})

test('tabで4列目以降へ字下げした行をfence開始・終了として扱わない', async () => {
  const unsafeHtml = '<img src=x onerror=alert(1)>'

  for (let spaces = 0; spaces <= 3; spaces += 1) {
    const opening = ' '.repeat(spaces) + '\t```info'
    const body = [opening, unsafeHtml, '```'].join('\n')

    await assertRejectedMarkdown(body, /raw HTML/)
    assert.match(await renderMarkdown(body), /<img\b[^>]*\bonerror=/i, opening)
  }

  const bodyWithTabbedClosing = ['```html', 'sample', '\t```', unsafeHtml].join(
    '\n',
  )

  await assertAcceptedMarkdown(bodyWithTabbedClosing)
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
    await assertAcceptedMarkdown(body)
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
    await assertRejectedMarkdown(body, /危険なURL/)
    assert.match(await renderMarkdown(body), renderedPattern)
  }
})

test('引用符内の感嘆符は許可しYAML aliasは拒否する', async () => {
  await assertAcceptedMarkdown('本文', "title: 'Example !!'")

  const result = await validateCmsFileContents(
    'src/content/blog/example.md',
    Buffer.from(`${validFrontmatter('title: &shared Example')}\n本文\n`),
  )

  assert.equal(result.ok, false)
  assert.match(result.message, /許可されていないYAML構文/)
})

test('CMS mediaはraster実体だけを許可しSVGとPDFを対象外にする', async () => {
  assert.equal(isAllowedCmsWritePath('public/uploads/hatt/vector.svg'), false)
  assert.equal(isAllowedCmsWritePath('public/uploads/hatt/document.pdf'), false)

  assert.deepEqual(
    await validateCmsFileContents(
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
      await validateCmsFileContents(
        `public/uploads/hatt/valid.${extension}`,
        bytes,
      ),
      { ok: true },
      extension,
    )
  }
})

test('CMS textは448 KiBまで受理し超過を保存前に拒否する', async () => {
  const campaign = Buffer.from(
    JSON.stringify({
      id: 'text-boundary',
      enabled: false,
      kind: 'notice',
      placement: 'global',
      title: 'Text boundary',
    }),
  )
  const exactLimit = Buffer.alloc(MAX_CMS_TEXT_FILE_BYTES, 0x20)
  const overLimit = Buffer.alloc(MAX_CMS_TEXT_FILE_BYTES + 1, 0x20)

  campaign.copy(exactLimit)
  campaign.copy(overLimit)

  assert.deepEqual(
    await validateCmsFileContents(
      'src/content/campaigns/text-boundary.json',
      exactLimit,
    ),
    { ok: true },
  )
  assert.equal(
    (
      await validateCmsFileContents(
        'src/content/campaigns/text-boundary.json',
        overLimit,
      )
    ).ok,
    false,
  )
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
      (
        await validateCmsFileContents(
          path,
          bytes.subarray(0, prefixLengths[extension]),
        )
      ).ok,
      false,
      `${extension} header-only`,
    )
    assert.equal(
      (
        await validateCmsFileContents(
          path,
          bytes.subarray(0, bytes.byteLength - 1),
        )
      ).ok,
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
      (
        await validateCmsFileContents(
          `public/uploads/hatt/invalid.${extension}`,
          bytes,
        )
      ).ok,
      false,
      `${extension} length mismatch`,
    )
  }
})

test('PNGは全chunkのCRC不一致を拒否する', async () => {
  const png = createMinimalPng()
  const corrupted = Buffer.from(png)

  corrupted[corrupted.byteLength - 1] ^= 0x01

  assert.equal(
    (
      await validateCmsFileContents(
        'public/uploads/hatt/corrupted-crc.png',
        corrupted,
      )
    ).ok,
    false,
  )
})

test('PNGは壊れたdeflateと不正なscanlineを拒否する', async () => {
  const invalidImages = [
    createMinimalPng({
      compressed: Buffer.from([0x78, 0x9c, 0x00, 0x00]),
    }),
    createMinimalPng({
      rawScanlines: Buffer.from([5, 24, 96, 160, 255]),
    }),
    createMinimalPng({
      rawScanlines: Buffer.from([0, 24, 96, 160]),
    }),
    createMinimalPng({
      rawScanlines: Buffer.from([0, 24, 96, 160, 255, 0]),
    }),
  ]

  for (const bytes of invalidImages) {
    assert.equal(
      (
        await validateCmsFileContents(
          'public/uploads/hatt/invalid-scanline.png',
          bytes,
        )
      ).ok,
      false,
    )
  }
})

test('PNGはIHDR制約を検証し連続する複数IDATを連結して展開する', async () => {
  assert.deepEqual(
    await validateCmsFileContents(
      'public/uploads/hatt/split-idat.png',
      createMinimalPng({ splitImageData: true }),
    ),
    { ok: true },
  )

  for (const bytes of [
    createMinimalPng({ bitDepth: 4 }),
    createMinimalPng({ interlaceMethod: 2 }),
    createMinimalPng({ width: 0 }),
    createMinimalPng({
      beforeImageData: [createPngChunk('abcD', Buffer.alloc(0))],
    }),
  ]) {
    assert.equal(
      (
        await validateCmsFileContents(
          'public/uploads/hatt/invalid-header.png',
          bytes,
        )
      ).ok,
      false,
    )
  }
})

test('raster containerの極端な小block列を上限で拒否する', async () => {
  const images = await rasterImagesPromise
  const pngChunkFlood = createMinimalPng({
    beforeImageData: Array.from({ length: 8_192 }, () =>
      createPngChunk('teSt', Buffer.alloc(0)),
    ),
  })
  const pngIdatFlood = createMinimalPng({
    beforeImageData: Array.from({ length: 4_096 }, () =>
      createPngChunk('IDAT', Buffer.alloc(0)),
    ),
  })
  const jpegSegment = Buffer.from([0xff, 0xe1, 0x00, 0x02])
  const jpegFlood = Buffer.concat([
    images.jpg.subarray(0, 2),
    ...Array.from({ length: 8_193 }, () => jpegSegment),
    images.jpg.subarray(2),
  ])
  const gifFlood = Buffer.concat([
    images.gif.subarray(0, -1),
    Buffer.alloc(8_193),
    images.gif.subarray(-1),
  ])
  const webpChunk = Buffer.from([
    0x4a, 0x55, 0x4e, 0x4b, 0x00, 0x00, 0x00, 0x00,
  ])
  const webpFlood = Buffer.concat([
    images.webp.subarray(0, 12),
    ...Array.from({ length: 8_193 }, () => webpChunk),
    images.webp.subarray(12),
  ])
  webpFlood.writeUInt32LE(webpFlood.byteLength - 8, 4)
  const avifFreeBox = Buffer.from([
    0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65,
  ])
  const avifFtypEnd = images.avif.readUInt32BE(0)
  const avifFlood = Buffer.concat([
    images.avif.subarray(0, avifFtypEnd),
    ...Array.from({ length: 8_193 }, () => avifFreeBox),
    images.avif.subarray(avifFtypEnd),
  ])

  for (const [extension, bytes] of [
    ['png', pngChunkFlood],
    ['png', pngIdatFlood],
    ['jpg', jpegFlood],
    ['gif', gifFlood],
    ['webp', webpFlood],
    ['avif', avifFlood],
  ]) {
    assert.equal(
      (
        await validateCmsFileContents(
          `public/uploads/hatt/block-flood.${extension}`,
          bytes,
        )
      ).ok,
      false,
      extension,
    )
  }
})

test('JPEG entropy内のbyte stuffingとrestart相当値をstructural marker上限へ数えない', async () => {
  const jpeg = (await rasterImagesPromise).jpg
  const stuffedEntropy = Buffer.alloc(8_300 * 4)

  for (let offset = 0; offset < stuffedEntropy.byteLength; offset += 4) {
    stuffedEntropy[offset] = 0xff
    stuffedEntropy[offset + 1] = 0x00
    stuffedEntropy[offset + 2] = 0xff
    stuffedEntropy[offset + 3] = 0xd0 + ((offset / 4) % 8)
  }

  const structurallyValid = Buffer.concat([
    jpeg.subarray(0, -2),
    stuffedEntropy,
    jpeg.subarray(-2),
  ])

  assert.deepEqual(
    await validateCmsFileContents(
      'public/uploads/hatt/stuffed-entropy.jpg',
      structurallyValid,
    ),
    { ok: true },
  )
})

test('CMS JSONは共有schemaと安全なURL制約に一致しなければ拒否する', async () => {
  const campaign = {
    id: 'unsafe',
    enabled: true,
    kind: 'notice',
    placement: 'global',
    title: 'Unsafe',
  }

  assert.equal(
    (
      await validateCmsFileContents(
        'src/content/campaigns/unsafe.json',
        Buffer.from(
          JSON.stringify({ ...campaign, href: 'javascript:alert(1)' }),
        ),
      )
    ).ok,
    false,
  )
  assert.equal(
    (
      await validateCmsFileContents(
        'src/content/campaigns/unsafe.json',
        Buffer.from(JSON.stringify({ ...campaign, placement: 'unknown' })),
      )
    ).ok,
    false,
  )
  assert.equal(
    (
      await validateCmsFileContents(
        'src/content/campaigns/unsafe.json',
        Buffer.from(JSON.stringify({ ...campaign, unexpected: true })),
      )
    ).ok,
    false,
  )
  assert.equal(
    (
      await validateCmsFileContents(
        'src/content/campaigns/different.json',
        Buffer.from(JSON.stringify(campaign)),
      )
    ).ok,
    false,
  )

  for (const slug of [
    '',
    '../../../outside',
    'nested/route',
    'x'.repeat(121),
  ]) {
    assert.equal(
      (
        await validateCmsFileContents(
          'src/content/tags/unsafe.json',
          Buffer.from(
            JSON.stringify({
              id: 'unsafe',
              name: 'Unsafe',
              slug,
            }),
          ),
        )
      ).ok,
      false,
      `tag slug ${slug}`,
    )
    assert.equal(
      (
        await validateCmsFileContents(
          'src/content/blog/unsafe.md',
          Buffer.from(
            [
              '---',
              'title: Unsafe',
              `slug: ${JSON.stringify(slug)}`,
              'description: Unsafe route slug',
              'date: 2026-07-29T12:00+09:00',
              'author: hatt',
              '---',
              'Unsafe',
              '',
            ].join('\n'),
          ),
        )
      ).ok,
      false,
      `blog slug ${slug}`,
    )
  }

  for (const authorId of ['', '..', 'nested/author', 'x'.repeat(121)]) {
    assert.equal(contentRouteSlugSchema.safeParse(authorId).success, false)
  }

  assert.equal(
    (
      await validateCmsFileContents(
        'src/content/authors/Unsafe Author.json',
        Buffer.from(
          JSON.stringify({
            id: 'Unsafe Author',
            name: 'Unsafe',
            bio: 'Unsafe author route',
          }),
        ),
      )
    ).ok,
    false,
  )

  assert.deepEqual(
    await validateCmsFileContents(
      'src/content/tags/safe-route_1.json',
      Buffer.from(
        JSON.stringify({
          id: 'safe-route_1',
          name: 'Safe',
          slug: 'safe-route_1',
        }),
      ),
    ),
    { ok: true },
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

function createMinimalPng({
  beforeImageData = [],
  bitDepth = 8,
  compressed,
  interlaceMethod = 0,
  rawScanlines = Buffer.from([0, 24, 96, 160, 255]),
  splitImageData = false,
  width = 1,
} = {}) {
  const header = Buffer.alloc(13)

  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(1, 4)
  header[8] = bitDepth
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = interlaceMethod

  const imageData = compressed ?? deflateSync(rawScanlines)
  const splitAt = Math.max(1, Math.floor(imageData.byteLength / 2))
  const imageChunks = splitImageData
    ? [
        createPngChunk('IDAT', imageData.subarray(0, splitAt)),
        createPngChunk('IDAT', imageData.subarray(splitAt)),
      ]
    : [createPngChunk('IDAT', imageData)]

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk('IHDR', header),
    ...beforeImageData,
    ...imageChunks,
    createPngChunk('IEND', Buffer.alloc(0)),
  ])
}

function createPngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(data.byteLength + 12)

  chunk.writeUInt32BE(data.byteLength, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(
    calculateTestCrc32(Buffer.concat([typeBytes, data])),
    8 + data.byteLength,
  )

  return chunk
}

function calculateTestCrc32(bytes) {
  let crc = 0xffffffff

  for (const byte of bytes) {
    crc ^= byte

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }

  return (crc ^ 0xffffffff) >>> 0
}

async function assertAcceptedMarkdown(body, title = 'title: Example') {
  assert.deepEqual(
    await validateCmsFileContents(
      'src/content/blog/example.md',
      Buffer.from(`${validFrontmatter(title)}\n${body}\n`),
    ),
    { ok: true },
  )
}

async function assertRejectedMarkdown(body, pattern) {
  const result = await validateCmsFileContents(
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
