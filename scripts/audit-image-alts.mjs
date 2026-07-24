import { readdir, readFile } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'

const outputDirectory = resolve(process.cwd(), 'dist')

async function listHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory()
        ? listHtmlFiles(path)
        : extname(entry.name).toLowerCase() === '.html'
          ? [path]
          : []
    }),
  )

  return files.flat()
}

function decodeWhitespaceEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/gi, ' ')
}

function findImageAltIssues(html, file) {
  const issues = []
  const imageTags = html.matchAll(/<img\b[^>]*>/gi)
  let imageCount = 0

  for (const match of imageTags) {
    imageCount += 1
    const tag = match[0]
    const altMatch = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const line = html.slice(0, match.index).split('\n').length

    if (!altMatch) {
      issues.push({ file, line, reason: 'alt 属性がありません', tag })
      continue
    }

    const alt = decodeWhitespaceEntities(
      altMatch[1] ?? altMatch[2] ?? altMatch[3] ?? '',
    ).trim()

    if (!alt) {
      issues.push({ file, line, reason: 'alt 属性が空です', tag })
    }
  }

  return { imageCount, issues }
}

const htmlFiles = await listHtmlFiles(outputDirectory)
const results = await Promise.all(
  htmlFiles.map(async (file) => {
    const html = await readFile(file, 'utf8')
    return findImageAltIssues(html, relative(outputDirectory, file))
  }),
)
const imageCount = results.reduce(
  (total, result) => total + result.imageCount,
  0,
)
const issues = results.flatMap((result) => result.issues)

if (issues.length > 0) {
  console.error(
    `画像 alt 監査に失敗しました: ${issues.length}件の空または欠落を検出`,
  )
  for (const issue of issues) {
    console.error(`- ${issue.file}:${issue.line} ${issue.reason}`)
    console.error(`  ${issue.tag}`)
  }
  process.exitCode = 1
} else {
  console.log(
    `画像 alt 監査: ${htmlFiles.length} HTML / ${imageCount} img、空・欠落 0件`,
  )
}
