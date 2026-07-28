import { JSON_SCHEMA, load as parseYaml } from 'js-yaml'

import {
  artContentSchema,
  authorContentSchema,
  blogContentSchema,
  campaignContentSchema,
  modelingContentSchema,
  siteContentSchema,
  tagContentSchema,
} from '../../../src/content-schemas.ts'

type CmsContentValidation = { ok: true } | { ok: false; message: string }

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
const MAX_FRONTMATTER_CHARS = 256 * 1024
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
  { prefix: 'src/content/tags/', schema: tagContentSchema },
] as const

export function validateCmsFileContents(
  path: string,
  bytes: Uint8Array,
): CmsContentValidation {
  if (path === 'src/content/site/main.json') {
    return validateJson(path, bytes, siteContentSchema)
  }

  const jsonRule = JSON_SCHEMAS.find(({ prefix }) => path.startsWith(prefix))

  if (jsonRule && path.endsWith('.json')) {
    return validateJson(path, bytes, jsonRule.schema)
  }

  if (path.startsWith('src/content/blog/') && path.endsWith('.md')) {
    return validateMarkdown(path, bytes)
  }

  if (path.startsWith('public/uploads/hatt/')) {
    return validateRasterImage(path, bytes)
  }

  return { ok: false, message: `${path}: CMS管理対象の形式ではありません。` }
}

function validateJson(
  path: string,
  bytes: Uint8Array,
  schema: (typeof JSON_SCHEMAS)[number]['schema'] | typeof siteContentSchema,
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

function validateRasterImage(
  path: string,
  bytes: Uint8Array,
): CmsContentValidation {
  const extension = getExtension(path)
  const valid =
    (extension === '.png' && isPng(bytes)) ||
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
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_TEXT_FILE_BYTES) {
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

function stripMarkdownCode(value: string) {
  const lines = value.split(/\r?\n/)
  const visibleLines: string[] = []
  let fence: { character: '`' | '~'; length: number } | null = null

  for (const line of lines) {
    if (fence) {
      const closing = line.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/)

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

    const opening = line.match(/^[ \t]{0,3}(`{3,}|~{3,}).*$/)

    if (opening) {
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

    const marker = value.slice(cursor, openingEnd)
    const closing = value.indexOf(marker, openingEnd)

    if (closing === -1) {
      result += marker
      cursor = openingEnd
      continue
    }

    result += ' '.repeat(closing + marker.length - cursor)
    cursor = closing + marker.length
  }

  return result
}

function findMarkdownDestinations(value: string) {
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

function hasDangerousProtocol(value: string) {
  const normalized = value
    .replace(/\\([^\s])/g, '$1')
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10)

      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : ''
    })
    .replace(/&colon;/gi, ':')
    .replace(/&(tab|newline);/gi, '')
    .replace(/[\u0000-\u0020\u007f]+/g, '')
    .toLowerCase()

  return (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('vbscript:') ||
    normalized.startsWith('data:')
  )
}

function isPng(bytes: Uint8Array) {
  return matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

function isJpeg(bytes: Uint8Array) {
  return matches(bytes, [0xff, 0xd8, 0xff])
}

function isGif(bytes: Uint8Array) {
  return matchesAscii(bytes, 'GIF87a') || matchesAscii(bytes, 'GIF89a')
}

function isWebp(bytes: Uint8Array) {
  return (
    bytes.byteLength >= 12 &&
    matchesAscii(bytes, 'RIFF') &&
    matchesAscii(bytes, 'WEBP', 8)
  )
}

function isAvif(bytes: Uint8Array) {
  if (bytes.byteLength < 16 || !matchesAscii(bytes, 'ftyp', 4)) return false

  for (
    let offset = 8;
    offset + 4 <= Math.min(bytes.byteLength, 64);
    offset += 4
  ) {
    if (
      matchesAscii(bytes, 'avif', offset) ||
      matchesAscii(bytes, 'avis', offset)
    ) {
      return true
    }
  }

  return false
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
