import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const routeSources = new Map([
  [
    '/',
    [
      'src/pages/index.astro',
      'src/content/site/main.json',
      'src/content/campaigns',
    ],
  ],
  ['/art/', ['src/pages/art.astro', 'src/content/art']],
  [
    '/blog/',
    ['src/pages/blog/index.astro', 'src/content/authors', 'src/content/tags'],
  ],
  ['/modeling-course/', ['src/pages/modeling-course.astro']],
  ['/modeling/', ['src/pages/modeling.astro', 'src/content/modeling']],
  ['/novels/', ['src/pages/novels.astro']],
  ['/profile/', ['src/pages/profile.astro', 'src/content/site/main.json']],
  ['/videos/', ['src/pages/videos.astro']],
])

function dateOnly(value) {
  const match = value?.trim().match(/^(\d{4}-\d{2}-\d{2})/)
  return match?.[1]
}

function latestDate(...values) {
  return values.filter(Boolean).sort().at(-1)
}

export function getGitLastModifiedDate(relativePaths, cwd = projectRoot) {
  if (!relativePaths || relativePaths.length === 0) return undefined

  try {
    const isShallow = execFileSync(
      'git',
      ['rev-parse', '--is-shallow-repository'],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim()

    // A shallow boundary makes the oldest available commit look like it added
    // every tracked path. Returning that date would be indistinguishable from
    // assigning the build/deploy commit to unchanged pages.
    if (isShallow === 'true') return undefined

    const value = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', ...relativePaths],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim()

    return dateOnly(value)
  } catch {
    return undefined
  }
}

function frontmatterValue(source, key) {
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1]
  if (!frontmatter) return undefined

  const value = frontmatter.match(
    new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'),
  )?.[1]
  if (!value) return undefined

  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === "'" || quote === '"') && trimmed.at(-1) === quote) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

function getBlogArticleDates(root) {
  const blogRoot = path.join(root, 'src', 'content', 'blog')
  const dates = new Map()

  try {
    for (const entry of readdirSync(blogRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue

      const source = readFileSync(path.join(blogRoot, entry.name), 'utf8')
      const slug = frontmatterValue(source, 'slug')
      const modified =
        dateOnly(frontmatterValue(source, 'lastUpdated')) ??
        dateOnly(frontmatterValue(source, 'date'))

      if (slug && modified) {
        dates.set(`/blog/article/${slug}/`, modified)
      }
    }
  } catch {
    // Content without a trustworthy date is intentionally omitted.
  }

  return dates
}

export function createSitemapLastmodResolver(root = projectRoot) {
  const dates = new Map()

  for (const [pathname, sources] of routeSources) {
    const modified = getGitLastModifiedDate(sources, root)
    if (modified) dates.set(pathname, modified)
  }

  const articleDates = getBlogArticleDates(root)
  for (const [pathname, modified] of articleDates) {
    dates.set(pathname, modified)
  }

  const blogModified = latestDate(dates.get('/blog/'), ...articleDates.values())
  if (blogModified) dates.set('/blog/', blogModified)

  return (pageUrl) => {
    try {
      return dates.get(new URL(pageUrl).pathname)
    } catch {
      return undefined
    }
  }
}
