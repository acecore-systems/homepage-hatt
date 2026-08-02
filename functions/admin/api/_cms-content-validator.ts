import { JSON_SCHEMA, load as parseYaml } from 'js-yaml'

import {
  artContentSchema,
  authorContentSchema,
  blogContentSchema,
  campaignContentSchema,
  modelingContentSchema,
  shopProductContentSchema,
  shopSettingsContentSchema,
  siteContentSchema,
  tagContentSchema,
} from '../../../src/content-schemas.ts'

type CmsContentValidation = { ok: true } | { ok: false; message: string }

export const MAX_CMS_TEXT_FILE_BYTES = 448 * 1024
const MAX_FRONTMATTER_CHARS = 256 * 1024
const MAX_PNG_INFLATED_BYTES = 64 * 1024 * 1024
const MAX_PNG_PIXELS = 100_000_000
const MAX_RASTER_BLOCKS = 8_192
const MAX_PNG_IDAT_CHUNKS = 4_096
const UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: false,
})
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const YAML_ALIAS_OR_TAG_PATTERN =
  /(?:^|[\s:[{,])(?:&|\*)[A-Za-z0-9_-]+|(?:^|[\s:[{,])!!|!</m
const RAW_HTML_PATTERN =
  /<!--|<![A-Za-z]|<\?\w|<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^>]*)?\/?>/

const JSON_SCHEMAS = [
  { prefix: 'src/content/art/', schema: artContentSchema },
  { prefix: 'src/content/authors/', schema: authorContentSchema },
  { prefix: 'src/content/campaigns/', schema: campaignContentSchema },
  { prefix: 'src/content/modeling/', schema: modelingContentSchema },
  { prefix: 'src/content/products/', schema: shopProductContentSchema },
  { prefix: 'src/content/tags/', schema: tagContentSchema },
] as const
const PATH_DERIVED_ID_PREFIXES = new Set([
  'src/content/authors/',
  'src/content/campaigns/',
  'src/content/tags/',
])

export async function validateCmsFileContents(
  path: string,
  bytes: Uint8Array,
): Promise<CmsContentValidation> {
  if (path === 'src/content/site/main.json') {
    return validateJson(path, bytes, siteContentSchema)
  }

  if (path === 'src/content/shop-settings/main.json') {
    return validateJson(path, bytes, shopSettingsContentSchema)
  }

  const jsonRule = JSON_SCHEMAS.find(({ prefix }) => path.startsWith(prefix))

  if (jsonRule && path.endsWith('.json')) {
    return validateJson(path, bytes, jsonRule.schema)
  }

  if (path.startsWith('src/content/blog/') && path.endsWith('.md')) {
    return validateMarkdown(path, bytes)
  }

  if (path.startsWith('public/uploads/hatt/')) {
    return await validateRasterImage(path, bytes)
  }

  return { ok: false, message: `${path}: CMS管理対象の形式ではありません。` }
}

function validateJson(
  path: string,
  bytes: Uint8Array,
  schema:
    | (typeof JSON_SCHEMAS)[number]['schema']
    | typeof siteContentSchema
    | typeof shopSettingsContentSchema,
): CmsContentValidation {
  const text = decodeText(path, bytes)

  if (!text.ok) return text

  let value: unknown

  try {
    value = JSON.parse(text.value)
  } catch {
    return { ok: false, message: `${path}: JSONとして解析できません。` }
  }

  const result = schema.safeParse(value)

  if (!result.success) {
    const issue = result.error.issues[0]
    const location = issue?.path.length ? ` (${issue.path.join('.')})` : ''

    return {
      ok: false,
      message: `${path}: コンテンツschemaに一致しません${location}。`,
    }
  }

  const identityValidation = validatePathDerivedId(path, result.data)

  if (!identityValidation.ok) return identityValidation

  return { ok: true }
}

function validatePathDerivedId(
  path: string,
  value: unknown,
): CmsContentValidation {
  const prefix = Array.from(PATH_DERIVED_ID_PREFIXES).find((candidate) =>
    path.startsWith(candidate),
  )

  if (!prefix) return { ok: true }

  const relativePath = path.slice(prefix.length)
  const expectedId = relativePath.endsWith('.json')
    ? relativePath.slice(0, -'.json'.length)
    : ''

  if (
    !expectedId ||
    expectedId.includes('/') ||
    !isRecord(value) ||
    value.id !== expectedId
  ) {
    return {
      ok: false,
      message: `${path}: idはJSONファイル名と一致させてください。`,
    }
  }

  return { ok: true }
}

function validateMarkdown(
  path: string,
  bytes: Uint8Array,
): CmsContentValidation {
  const text = decodeText(path, bytes)

  if (!text.ok) return text

  const frontmatterMatch = FRONTMATTER_PATTERN.exec(text.value)

  if (!frontmatterMatch || !frontmatterMatch[1].trim()) {
    return {
      ok: false,
      message: `${path}: YAML frontmatterがありません。`,
    }
  }

  const rawFrontmatter = frontmatterMatch[1]

  if (
    rawFrontmatter.length > MAX_FRONTMATTER_CHARS ||
    YAML_ALIAS_OR_TAG_PATTERN.test(stripYamlQuotedText(rawFrontmatter))
  ) {
    return {
      ok: false,
      message: `${path}: frontmatterに許可されていないYAML構文があります。`,
    }
  }

  let frontmatter: unknown

  try {
    frontmatter = parseYaml(rawFrontmatter, {
      json: false,
      schema: JSON_SCHEMA,
    })
  } catch {
    return {
      ok: false,
      message: `${path}: YAML frontmatterを解析できません。`,
    }
  }

  const result = blogContentSchema.safeParse(frontmatter)

  if (!result.success) {
    const issue = result.error.issues[0]
    const location = issue?.path.length ? ` (${issue.path.join('.')})` : ''

    return {
      ok: false,
      message: `${path}: frontmatterがコンテンツschemaに一致しません${location}。`,
    }
  }

  const body = stripMarkdownCode(text.value.slice(frontmatterMatch[0].length))
  const withoutSafeAutolinks = body.replace(
    /<(?:https:\/\/|mailto:|tel:)[^<>\s]+>/gi,
    '',
  )

  if (RAW_HTML_PATTERN.test(withoutSafeAutolinks)) {
    return {
      ok: false,
      message: `${path}: Markdown本文のraw HTMLは許可されていません。`,
    }
  }

  if (findMarkdownDestinations(body).some(hasDangerousProtocol)) {
    return {
      ok: false,
      message: `${path}: Markdownリンクに危険なURL schemeがあります。`,
    }
  }

  return { ok: true }
}

function stripYamlQuotedText(value: string) {
  let result = ''
  let quote: "'" | '"' | null = null

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]

    if (!quote) {
      if (character === "'" || character === '"') {
        quote = character
        result += ' '
      } else {
        result += character
      }

      continue
    }

    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      result += '  '
      index += 1
      continue
    }

    if (quote === '"' && character === '\\' && index + 1 < value.length) {
      result += '  '
      index += 1
      continue
    }

    if (character === quote) quote = null

    result += character === '\n' || character === '\r' ? character : ' '
  }

  return result
}

async function validateRasterImage(
  path: string,
  bytes: Uint8Array,
): Promise<CmsContentValidation> {
  const extension = getExtension(path)
  const valid =
    (extension === '.png' && (await isPng(bytes))) ||
    ((extension === '.jpg' || extension === '.jpeg') && isJpeg(bytes)) ||
    (extension === '.gif' && isGif(bytes)) ||
    (extension === '.webp' && isWebp(bytes)) ||
    (extension === '.avif' && isAvif(bytes))

  return valid
    ? { ok: true }
    : {
        ok: false,
        message: `${path}: 拡張子と画像データの形式が一致しません。`,
      }
}

function decodeText(
  path: string,
  bytes: Uint8Array,
): { ok: true; value: string } | { ok: false; message: string } {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CMS_TEXT_FILE_BYTES) {
    return {
      ok: false,
      message: `${path}: テキストファイルのサイズが不正です。`,
    }
  }

  try {
    return { ok: true, value: UTF8_DECODER.decode(bytes) }
  } catch {
    return { ok: false, message: `${path}: UTF-8として解析できません。` }
  }
}

export function stripMarkdownCode(value: string) {
  const lines = value.split(/\r?\n/)
  const visibleLines: string[] = []
  let fence: { character: '`' | '~'; length: number } | null = null

  for (const line of lines) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/)

      if (
        closing &&
        closing[1][0] === fence.character &&
        closing[1].length >= fence.length
      ) {
        fence = null
      }

      visibleLines.push('')
      continue
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)

    if (opening && (opening[1][0] === '~' || !opening[2].includes('`'))) {
      fence = {
        character: opening[1][0] as '`' | '~',
        length: opening[1].length,
      }
      visibleLines.push('')
      continue
    }

    visibleLines.push(stripInlineCode(line))
  }

  return visibleLines.join('\n')
}

function stripInlineCode(value: string) {
  let result = ''
  let cursor = 0

  while (cursor < value.length) {
    if (value[cursor] !== '`') {
      result += value[cursor]
      cursor += 1
      continue
    }

    let openingEnd = cursor

    while (value[openingEnd] === '`') openingEnd += 1

    if (isEscapedBacktickRun(value, cursor)) {
      result += value.slice(cursor, openingEnd)
      cursor = openingEnd
      continue
    }

    const marker = value.slice(cursor, openingEnd)
    const closing = findClosingBacktickRun(value, openingEnd, marker.length)

    if (!closing) {
      result += marker
      cursor = openingEnd
      continue
    }

    result += ' '.repeat(closing.end - cursor)
    cursor = closing.end
  }

  return result
}

function isEscapedBacktickRun(value: string, start: number) {
  let backslashes = 0

  for (let index = start - 1; index >= 0 && value[index] === '\\'; index -= 1) {
    backslashes += 1
  }

  return backslashes % 2 === 1
}

function findClosingBacktickRun(
  value: string,
  start: number,
  expectedLength: number,
) {
  let cursor = start

  while (cursor < value.length) {
    const opening = value.indexOf('`', cursor)

    if (opening === -1) return null

    let end = opening

    while (value[end] === '`') end += 1

    if (end - opening === expectedLength) return { end }

    cursor = end
  }

  return null
}

export function findMarkdownDestinations(value: string) {
  const destinations: string[] = []
  const patterns = [
    /\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))/g,
    /^\s*\[[^\]\r\n]+\]:\s*(?:<([^>\r\n]+)>|([^\s\r\n]+))/gm,
    /<([A-Za-z][A-Za-z0-9+.-]*:[^<>\s]+)>/g,
  ]

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const destination = match[1] || match[2]

      if (destination) destinations.push(destination)
    }
  }

  return destinations
}

export function normalizeMarkdownDestination(value: string) {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    bsol: '\\',
    colon: ':',
    newline: '\n',
    num: '#',
    percnt: '%',
    period: '.',
    quest: '?',
    quot: '"',
    sol: '/',
    tab: '\t',
  }

  return value
    .replace(/\\([^\s])/g, '$1')
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (match, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10)

      if (
        !Number.isFinite(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return match
      }

      return String.fromCodePoint(codePoint)
    })
    .replace(
      /&(amp|apos|bsol|colon|newline|num|percnt|period|quest|quot|sol|tab);/gi,
      (match, name: string) => namedEntities[name.toLowerCase()] ?? match,
    )
}

function hasDangerousProtocol(value: string) {
  const normalized = normalizeMarkdownDestination(value)
    .replace(/[\u0000-\u0020\u007f]+/g, '')
    .toLowerCase()

  return (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('vbscript:') ||
    normalized.startsWith('data:')
  )
}

async function isPng(bytes: Uint8Array) {
  if (!matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return false
  }

  let offset = 8
  let firstChunk = true
  let bitDepth = 0
  let colorType = 0
  let interlaceMethod = 0
  let width = 0
  let height = 0
  let hasPalette = false
  let hasImageData = false
  let imageDataEnded = false
  let chunkCount = 0
  let imageDataChunkCount = 0
  const imageDataChunks: Uint8Array[] = []

  while (offset + 12 <= bytes.byteLength) {
    chunkCount += 1
    if (chunkCount > MAX_RASTER_BLOCKS) return false

    const length = readUint32BigEndian(bytes, offset)
    const typeOffset = offset + 4
    const dataOffset = offset + 8
    const dataEnd = dataOffset + length
    const chunkEnd = dataEnd + 4

    if (
      length > bytes.byteLength - dataOffset - 4 ||
      chunkEnd > bytes.byteLength ||
      !isValidPngChunkType(bytes, typeOffset) ||
      calculateCrc32(bytes.subarray(typeOffset, dataEnd)) !==
        readUint32BigEndian(bytes, dataEnd)
    ) {
      return false
    }

    const type = ascii(bytes, typeOffset, 4)

    if (firstChunk) {
      if (
        type !== 'IHDR' ||
        length !== 13 ||
        !isValidPngHeader(bytes, dataOffset)
      ) {
        return false
      }

      width = readUint32BigEndian(bytes, dataOffset)
      height = readUint32BigEndian(bytes, dataOffset + 4)
      bitDepth = bytes[dataOffset + 8]
      colorType = bytes[dataOffset + 9]
      interlaceMethod = bytes[dataOffset + 12]
    } else if (type === 'IHDR') {
      return false
    }

    if (type === 'PLTE') {
      if (
        hasPalette ||
        hasImageData ||
        colorType === 0 ||
        colorType === 4 ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 256 * 3 ||
        (colorType === 3 && length / 3 > 2 ** bitDepth)
      ) {
        return false
      }

      hasPalette = true
    } else if (type === 'IDAT') {
      if (imageDataEnded) return false

      imageDataChunkCount += 1
      if (imageDataChunkCount > MAX_PNG_IDAT_CHUNKS) return false

      hasImageData = true
      if (length > 0) imageDataChunks.push(bytes.subarray(dataOffset, dataEnd))
    } else if (hasImageData) {
      imageDataEnded = true
    }

    if (
      isCriticalPngChunk(bytes[typeOffset]) &&
      !isKnownPngCriticalChunk(type)
    ) {
      return false
    }

    if (type === 'IEND') {
      if (
        length !== 0 ||
        !hasImageData ||
        imageDataChunks.length === 0 ||
        (colorType === 3 && !hasPalette) ||
        chunkEnd !== bytes.byteLength
      ) {
        return false
      }

      const layout = getPngScanLayout({
        bitDepth,
        colorType,
        height,
        interlaceMethod,
        width,
      })

      return (
        layout !== null && (await validatePngImageData(imageDataChunks, layout))
      )
    }

    firstChunk = false
    offset = chunkEnd
  }

  return false
}

type PngScanSegment = {
  rowBytes: number
  rows: number
}

type PngScanLayout = {
  expectedBytes: number
  segments: PngScanSegment[]
}

function isValidPngHeader(bytes: Uint8Array, offset: number) {
  const width = readUint32BigEndian(bytes, offset)
  const height = readUint32BigEndian(bytes, offset + 4)
  const bitDepth = bytes[offset + 8]
  const colorType = bytes[offset + 9]
  const compressionMethod = bytes[offset + 10]
  const filterMethod = bytes[offset + 11]
  const interlaceMethod = bytes[offset + 12]
  const validBitDepths = new Map<number, readonly number[]>([
    [0, [1, 2, 4, 8, 16]],
    [2, [8, 16]],
    [3, [1, 2, 4, 8]],
    [4, [8, 16]],
    [6, [8, 16]],
  ])

  return (
    width > 0 &&
    width <= 0x7fffffff &&
    height > 0 &&
    height <= 0x7fffffff &&
    (validBitDepths.get(colorType)?.includes(bitDepth) ?? false) &&
    compressionMethod === 0 &&
    filterMethod === 0 &&
    (interlaceMethod === 0 || interlaceMethod === 1)
  )
}

function getPngScanLayout({
  bitDepth,
  colorType,
  height,
  interlaceMethod,
  width,
}: {
  bitDepth: number
  colorType: number
  height: number
  interlaceMethod: number
  width: number
}): PngScanLayout | null {
  if (
    !Number.isSafeInteger(width * height) ||
    width * height > MAX_PNG_PIXELS
  ) {
    return null
  }

  const channelsByColorType = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4],
  ])
  const channels = channelsByColorType.get(colorType)

  if (!channels) return null

  const bitsPerPixel = channels * bitDepth
  const passes =
    interlaceMethod === 0
      ? [{ startX: 0, startY: 0, stepX: 1, stepY: 1 }]
      : [
          { startX: 0, startY: 0, stepX: 8, stepY: 8 },
          { startX: 4, startY: 0, stepX: 8, stepY: 8 },
          { startX: 0, startY: 4, stepX: 4, stepY: 8 },
          { startX: 2, startY: 0, stepX: 4, stepY: 4 },
          { startX: 0, startY: 2, stepX: 2, stepY: 4 },
          { startX: 1, startY: 0, stepX: 2, stepY: 2 },
          { startX: 0, startY: 1, stepX: 1, stepY: 2 },
        ]
  const segments: PngScanSegment[] = []
  let expectedBytes = 0

  for (const pass of passes) {
    if (width <= pass.startX || height <= pass.startY) continue

    const passWidth = Math.ceil((width - pass.startX) / pass.stepX)
    const rows = Math.ceil((height - pass.startY) / pass.stepY)
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8)
    const segmentBytes = rows * (rowBytes + 1)

    if (
      !Number.isSafeInteger(segmentBytes) ||
      segmentBytes > MAX_PNG_INFLATED_BYTES - expectedBytes
    ) {
      return null
    }

    segments.push({ rowBytes, rows })
    expectedBytes += segmentBytes
  }

  return expectedBytes > 0 ? { expectedBytes, segments } : null
}

async function validatePngImageData(
  chunks: readonly Uint8Array[],
  layout: PngScanLayout,
) {
  let chunkIndex = 0
  const source = new ReadableStream<ArrayBuffer | ArrayBufferView>({
    pull(controller) {
      const chunk = chunks[chunkIndex]

      if (chunk) {
        chunkIndex += 1
        controller.enqueue(chunk)
      } else {
        controller.close()
      }
    },
  })
  const reader = source
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader()
  let segmentIndex = 0
  let rowsRemaining = layout.segments[0]?.rows ?? 0
  let rowBytesRemaining = 0
  let inflatedBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      let offset = 0

      while (offset < value.byteLength) {
        if (rowBytesRemaining === 0) {
          while (segmentIndex < layout.segments.length && rowsRemaining === 0) {
            segmentIndex += 1
            rowsRemaining = layout.segments[segmentIndex]?.rows ?? 0
          }

          if (segmentIndex >= layout.segments.length || value[offset] > 4) {
            await reader.cancel()
            return false
          }

          rowBytesRemaining = layout.segments[segmentIndex].rowBytes
          rowsRemaining -= 1
          offset += 1
          inflatedBytes += 1
        }

        const available = value.byteLength - offset
        const consumed = Math.min(rowBytesRemaining, available)

        rowBytesRemaining -= consumed
        offset += consumed
        inflatedBytes += consumed

        if (inflatedBytes > layout.expectedBytes) {
          await reader.cancel()
          return false
        }
      }
    }
  } catch {
    return false
  }

  return (
    inflatedBytes === layout.expectedBytes &&
    rowBytesRemaining === 0 &&
    segmentIndex === layout.segments.length - 1 &&
    rowsRemaining === 0
  )
}

function isValidPngChunkType(bytes: Uint8Array, offset: number) {
  for (let index = 0; index < 4; index += 1) {
    const value = bytes[offset + index]

    if (!(
      (value >= 0x41 && value <= 0x5a) ||
      (value >= 0x61 && value <= 0x7a)
    )) {
      return false
    }
  }

  return bytes[offset + 2] >= 0x41 && bytes[offset + 2] <= 0x5a
}

function isCriticalPngChunk(firstTypeByte: number) {
  return firstTypeByte >= 0x41 && firstTypeByte <= 0x5a
}

function isKnownPngCriticalChunk(type: string) {
  return (
    type === 'IHDR' || type === 'PLTE' || type === 'IDAT' || type === 'IEND'
  )
}

function calculateCrc32(bytes: Uint8Array) {
  let crc = 0xffffffff

  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let index = 0; index < table.length; index += 1) {
    let value = index

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }

    table[index] = value >>> 0
  }

  return table
})()

function isJpeg(bytes: Uint8Array) {
  if (!matches(bytes, [0xff, 0xd8]) || bytes.byteLength < 4) return false

  let offset = 2
  let hasFrame = false
  let hasScan = false
  let markerCount = 0

  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return false

    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.byteLength) return false

    const marker = bytes[offset]
    offset += 1
    markerCount += 1
    if (markerCount > MAX_RASTER_BLOCKS) return false

    if (marker === 0x00 || marker === 0xd8) return false
    if (marker === 0xd9) {
      return hasFrame && hasScan && offset === bytes.byteLength
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue

    if (offset + 2 > bytes.byteLength) return false

    const segmentLength = readUint16BigEndian(bytes, offset)
    const segmentEnd = offset + segmentLength

    if (segmentLength < 2 || segmentEnd > bytes.byteLength) return false

    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 8) return false

      const componentCount = bytes[offset + 7]
      const height = readUint16BigEndian(bytes, offset + 3)
      const width = readUint16BigEndian(bytes, offset + 5)

      if (
        componentCount === 0 ||
        segmentLength !== 8 + componentCount * 3 ||
        width === 0 ||
        height === 0
      ) {
        return false
      }

      hasFrame = true
    }

    if (marker !== 0xda) {
      offset = segmentEnd
      continue
    }

    const componentCount = bytes[offset + 2]
    if (componentCount === 0 || segmentLength !== 6 + componentCount * 2) {
      return false
    }

    hasScan = true
    offset = segmentEnd

    while (offset < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }

      const markerOffset = offset
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
      if (offset >= bytes.byteLength) return false

      const scanMarker = bytes[offset]

      if (
        scanMarker === 0x00 ||
        scanMarker === 0x01 ||
        (scanMarker >= 0xd0 && scanMarker <= 0xd7)
      ) {
        offset += 1
        continue
      }

      offset = markerOffset
      break
    }
  }

  return false
}

function isGif(bytes: Uint8Array) {
  if (
    bytes.byteLength < 14 ||
    (!matchesAscii(bytes, 'GIF87a') && !matchesAscii(bytes, 'GIF89a')) ||
    readUint16LittleEndian(bytes, 6) === 0 ||
    readUint16LittleEndian(bytes, 8) === 0
  ) {
    return false
  }

  const logicalScreenPacked = bytes[10]
  const hasGlobalColorTable = (logicalScreenPacked & 0x80) !== 0
  let offset = 13

  if (hasGlobalColorTable) {
    offset += 3 * 2 ** ((logicalScreenPacked & 0x07) + 1)
    if (offset > bytes.byteLength) return false
  }

  let hasImage = false
  const blockBudget = { remaining: MAX_RASTER_BLOCKS }

  while (offset < bytes.byteLength) {
    if (!consumeRasterBlock(blockBudget)) return false

    const blockType = bytes[offset]
    offset += 1

    if (blockType === 0x3b) {
      return hasImage && offset === bytes.byteLength
    }

    if (blockType === 0x00) continue

    if (blockType === 0x21) {
      if (offset >= bytes.byteLength) return false
      offset += 1
      offset = skipGifSubBlocks(bytes, offset, blockBudget)
      if (offset === -1) return false
      continue
    }

    if (blockType !== 0x2c || offset + 9 > bytes.byteLength) return false

    const width = readUint16LittleEndian(bytes, offset + 4)
    const height = readUint16LittleEndian(bytes, offset + 6)
    const imagePacked = bytes[offset + 8]
    const hasLocalColorTable = (imagePacked & 0x80) !== 0

    if (width === 0 || height === 0) return false

    offset += 9
    if (hasLocalColorTable) {
      offset += 3 * 2 ** ((imagePacked & 0x07) + 1)
      if (offset > bytes.byteLength) return false
    } else if (!hasGlobalColorTable) {
      return false
    }

    if (
      offset >= bytes.byteLength ||
      bytes[offset] === 0 ||
      bytes[offset] > 12
    ) {
      return false
    }

    offset = skipGifSubBlocks(bytes, offset + 1, blockBudget)
    if (offset === -1) return false
    hasImage = true
  }

  return false
}

function isWebp(bytes: Uint8Array) {
  if (
    bytes.byteLength < 20 ||
    !matchesAscii(bytes, 'RIFF') ||
    !matchesAscii(bytes, 'WEBP', 8) ||
    readUint32LittleEndian(bytes, 4) !== bytes.byteLength - 8
  ) {
    return false
  }

  let offset = 12
  let hasImageData = false
  const blockBudget = { remaining: MAX_RASTER_BLOCKS }

  while (offset < bytes.byteLength) {
    if (!consumeRasterBlock(blockBudget)) return false
    if (offset + 8 > bytes.byteLength) return false

    const chunkSize = readUint32LittleEndian(bytes, offset + 4)
    const dataOffset = offset + 8
    const dataEnd = dataOffset + chunkSize
    const chunkEnd = dataEnd + (chunkSize % 2)

    if (chunkEnd > bytes.byteLength) return false

    if (matchesAscii(bytes, 'VP8X', offset) && chunkSize !== 10) return false

    if (matchesAscii(bytes, 'VP8 ', offset)) {
      if (!isValidVp8Payload(bytes, dataOffset, dataEnd)) return false
      hasImageData = true
    } else if (matchesAscii(bytes, 'VP8L', offset)) {
      if (!isValidVp8lPayload(bytes, dataOffset, dataEnd)) return false
      hasImageData = true
    } else if (matchesAscii(bytes, 'ANMF', offset)) {
      if (
        dataEnd - dataOffset < 24 ||
        !hasValidWebpFrameChunks(bytes, dataOffset + 16, dataEnd, blockBudget)
      ) {
        return false
      }
      hasImageData = true
    }

    offset = chunkEnd
  }

  return hasImageData
}

function isAvif(bytes: Uint8Array) {
  const fileType = readIsoBox(bytes, 0, bytes.byteLength)
  if (
    !fileType ||
    fileType.type !== 'ftyp' ||
    fileType.endOffset - fileType.dataOffset < 8 ||
    (fileType.endOffset - fileType.dataOffset - 8) % 4 !== 0
  ) {
    return false
  }

  let hasAvifBrand =
    matchesAscii(bytes, 'avif', fileType.dataOffset) ||
    matchesAscii(bytes, 'avis', fileType.dataOffset)
  let hasSequenceBrand = matchesAscii(bytes, 'avis', fileType.dataOffset)
  const compatibleBrandCount =
    (fileType.endOffset - fileType.dataOffset - 8) / 4

  if (compatibleBrandCount > MAX_RASTER_BLOCKS) return false

  for (
    let offset = fileType.dataOffset + 8;
    offset + 4 <= fileType.endOffset;
    offset += 4
  ) {
    hasAvifBrand ||= matchesAscii(bytes, 'avif', offset)
    hasSequenceBrand ||= matchesAscii(bytes, 'avis', offset)
  }

  if (!hasAvifBrand) return false

  let offset = fileType.endOffset
  let hasMeta = false
  let hasMovie = false
  let hasMediaData = false
  const blockBudget = { remaining: MAX_RASTER_BLOCKS }

  while (offset < bytes.byteLength) {
    if (!consumeRasterBlock(blockBudget)) return false

    const box = readIsoBox(bytes, offset, bytes.byteLength)
    if (!box) return false

    if (box.type === 'mdat' && box.endOffset > box.dataOffset) {
      hasMediaData = true
    } else if (box.type === 'meta') {
      if (box.dataOffset + 4 > box.endOffset) return false

      const children = inspectIsoChildren(
        bytes,
        box.dataOffset + 4,
        box.endOffset,
        blockBudget,
      )
      if (!children.valid || !children.hasChild) return false

      hasMeta = true
      hasMediaData ||= children.hasItemData
    } else if (box.type === 'moov') {
      const children = inspectIsoChildren(
        bytes,
        box.dataOffset,
        box.endOffset,
        blockBudget,
      )
      if (!children.valid || !children.hasTrack) return false
      hasMovie = true
    }

    offset = box.endOffset
  }

  return hasMediaData && (hasMeta || (hasSequenceBrand && hasMovie))
}

type IsoBox = {
  type: string
  dataOffset: number
  endOffset: number
}

function isJpegStartOfFrame(marker: number) {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  )
}

function skipGifSubBlocks(
  bytes: Uint8Array,
  startOffset: number,
  blockBudget: { remaining: number },
) {
  let offset = startOffset

  while (offset < bytes.byteLength) {
    if (!consumeRasterBlock(blockBudget)) return -1

    const length = bytes[offset]
    offset += 1

    if (length === 0) return offset
    if (offset + length > bytes.byteLength) return -1

    offset += length
  }

  return -1
}

function isValidVp8Payload(
  bytes: Uint8Array,
  dataOffset: number,
  dataEnd: number,
) {
  return (
    dataEnd - dataOffset >= 10 &&
    matches(bytes, [0x9d, 0x01, 0x2a], dataOffset + 3) &&
    (readUint16LittleEndian(bytes, dataOffset + 6) & 0x3fff) !== 0 &&
    (readUint16LittleEndian(bytes, dataOffset + 8) & 0x3fff) !== 0
  )
}

function isValidVp8lPayload(
  bytes: Uint8Array,
  dataOffset: number,
  dataEnd: number,
) {
  return (
    dataEnd - dataOffset >= 5 &&
    bytes[dataOffset] === 0x2f &&
    (bytes[dataOffset + 4] & 0xe0) === 0
  )
}

function hasValidWebpFrameChunks(
  bytes: Uint8Array,
  startOffset: number,
  endOffset: number,
  blockBudget: { remaining: number },
) {
  let offset = startOffset
  let hasImageData = false

  while (offset < endOffset) {
    if (!consumeRasterBlock(blockBudget)) return false
    if (offset + 8 > endOffset) return false

    const chunkSize = readUint32LittleEndian(bytes, offset + 4)
    const dataOffset = offset + 8
    const dataEnd = dataOffset + chunkSize
    const chunkEnd = dataEnd + (chunkSize % 2)

    if (chunkEnd > endOffset) return false

    if (matchesAscii(bytes, 'VP8 ', offset)) {
      if (!isValidVp8Payload(bytes, dataOffset, dataEnd)) return false
      hasImageData = true
    } else if (matchesAscii(bytes, 'VP8L', offset)) {
      if (!isValidVp8lPayload(bytes, dataOffset, dataEnd)) return false
      hasImageData = true
    }

    offset = chunkEnd
  }

  return offset === endOffset && hasImageData
}

function readIsoBox(
  bytes: Uint8Array,
  offset: number,
  containerEnd: number,
): IsoBox | null {
  if (offset + 8 > containerEnd) return null

  let boxSize = readUint32BigEndian(bytes, offset)
  let headerSize = 8

  if (boxSize === 1) {
    if (offset + 16 > containerEnd) return null

    const high = readUint32BigEndian(bytes, offset + 8)
    const low = readUint32BigEndian(bytes, offset + 12)
    if (high > 0x1fffff) return null

    boxSize = high * 0x1_0000_0000 + low
    headerSize = 16
  } else if (boxSize === 0) {
    boxSize = containerEnd - offset
  }

  if (boxSize < headerSize || boxSize > containerEnd - offset) return null

  return {
    type: ascii(bytes, offset + 4, 4),
    dataOffset: offset + headerSize,
    endOffset: offset + boxSize,
  }
}

function inspectIsoChildren(
  bytes: Uint8Array,
  startOffset: number,
  endOffset: number,
  blockBudget: { remaining: number },
) {
  let offset = startOffset
  let hasChild = false
  let hasItemData = false
  let hasTrack = false

  while (offset < endOffset) {
    if (!consumeRasterBlock(blockBudget)) {
      return {
        valid: false,
        hasChild,
        hasItemData,
        hasTrack,
      }
    }

    const box = readIsoBox(bytes, offset, endOffset)
    if (!box) {
      return {
        valid: false,
        hasChild,
        hasItemData,
        hasTrack,
      }
    }

    hasChild = true
    hasItemData ||= box.type === 'idat' && box.endOffset > box.dataOffset
    hasTrack ||= box.type === 'trak'
    offset = box.endOffset
  }

  return {
    valid: offset === endOffset,
    hasChild,
    hasItemData,
    hasTrack,
  }
}

function consumeRasterBlock(blockBudget: { remaining: number }) {
  if (blockBudget.remaining <= 0) return false

  blockBudget.remaining -= 1
  return true
}

function readUint16BigEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset] * 0x100 + bytes[offset + 1]
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset] + bytes[offset + 1] * 0x100
}

function readUint32BigEndian(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  )
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  )
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  let value = ''

  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index])
  }

  return value
}

function matches(bytes: Uint8Array, signature: number[], offset = 0) {
  return (
    bytes.byteLength >= offset + signature.length &&
    signature.every((byte, index) => bytes[offset + index] === byte)
  )
}

function matchesAscii(bytes: Uint8Array, value: string, offset = 0) {
  return matches(
    bytes,
    Array.from(value, (character) => character.charCodeAt(0)),
    offset,
  )
}

function getExtension(path: string) {
  const fileName = path.split('/').pop() || ''
  const dot = fileName.lastIndexOf('.')

  return dot === -1 ? '' : fileName.slice(dot).toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
