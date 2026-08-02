import { JSON_SCHEMA, load as parseYaml } from 'js-yaml'

import {
  artContentSchema,
  authorContentSchema,
  blogContentSchema,
  campaignContentSchema,
  contentRouteSlugSchema,
  modelingContentSchema,
  siteContentSchema,
  tagContentSchema,
} from '../../../src/content-schemas.ts'
import {
  findMarkdownDestinations,
  normalizeMarkdownDestination,
  stripMarkdownCode,
  validateCmsFileContents,
} from './_cms-content-validator.ts'
import {
  isCmsReferenceStatePath,
  isCmsReferenceTextPath,
  normalizeCmsPath,
} from './_cms-policy.ts'
import { GitHubApiError, type CmsReferenceStateEntry } from './_github-api.ts'

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const LOCAL_MEDIA_URL_PREFIX = '/uploads/hatt/'
const LOCAL_MEDIA_PATH_PREFIX = 'public/uploads/hatt/'
const BASE_URL = 'https://cms-reference.invalid'
const TEXT_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: false,
})

type CmsAddition = {
  path: string
  contents: string
}

type CmsDeletion = {
  path: string
}

type ProjectedTextEntry = {
  kind: 'text'
  contents: string
}

type ProjectedMediaEntry = {
  kind: 'media'
}

type ProjectedEntry = ProjectedTextEntry | ProjectedMediaEntry

type ReferenceValidationInput = {
  additions: readonly CmsAddition[]
  currentState: readonly CmsReferenceStateEntry[]
  deletions: readonly CmsDeletion[]
}

type ContentReference = {
  sourcePath: string
  value: string | undefined
  markdown?: boolean
}

export async function validateProjectedCmsReferences({
  additions,
  currentState,
  deletions,
}: ReferenceValidationInput) {
  const projected = buildProjectedState({
    additions,
    currentState,
    deletions,
  })
  const mediaPaths = new Set(
    Array.from(projected.entries())
      .filter((entry): entry is [string, ProjectedMediaEntry] => {
        return entry[1].kind === 'media'
      })
      .map(([path]) => path),
  )
  const authorIds = new Set<string>()
  const tagIds = new Set<string>()
  const blogSlugs = new Map<string, string>()
  const tagSlugs = new Map<string, string>()
  const blogReferences: Array<{
    author: string
    tags: string[]
    path: string
  }> = []
  const contentReferences: ContentReference[] = []

  for (const [path, entry] of projected) {
    if (entry.kind !== 'text') continue

    const validation = await validateCmsFileContents(
      path,
      TEXT_ENCODER.encode(entry.contents),
    )

    if (!validation.ok) {
      throw new GitHubApiError(validation.message, 422)
    }

    collectContentReferences({
      authorIds,
      blogSlugs,
      blogReferences,
      contentReferences,
      contents: entry.contents,
      path,
      tagIds,
      tagSlugs,
    })
  }

  for (const blog of blogReferences) {
    if (!authorIds.has(blog.author)) {
      throw new GitHubApiError(
        `${blog.path}: author「${blog.author}」が存在しません。`,
        422,
      )
    }

    for (const tag of blog.tags) {
      if (!tagIds.has(tag)) {
        throw new GitHubApiError(
          `${blog.path}: tag「${tag}」が存在しません。`,
          422,
        )
      }
    }
  }

  for (const reference of contentReferences) {
    if (!reference.value) continue

    const mediaPath = resolveLocalMediaPath(
      reference.value,
      reference.markdown === true,
    )

    if (mediaPath && !mediaPaths.has(mediaPath)) {
      throw new GitHubApiError(
        `${reference.sourcePath}: 参照先の画像が存在しません: ${mediaPath}`,
        422,
      )
    }
  }
}

function buildProjectedState({
  additions,
  currentState,
  deletions,
}: ReferenceValidationInput) {
  const projected = new Map<string, ProjectedEntry>()

  for (const entry of currentState) {
    if (
      !isCmsReferenceStatePath(entry.path) ||
      projected.has(entry.path) ||
      (isCmsReferenceTextPath(entry.path)
        ? typeof entry.contents !== 'string'
        : entry.contents !== undefined)
    ) {
      throw new GitHubApiError('GitHub上のCMS参照状態が不正です。', 502)
    }

    projected.set(
      entry.path,
      isCmsReferenceTextPath(entry.path)
        ? { kind: 'text', contents: entry.contents as string }
        : { kind: 'media' },
    )
  }

  for (const { path } of deletions) {
    projected.delete(path)
  }

  for (const addition of additions) {
    if (!isCmsReferenceStatePath(addition.path)) continue

    projected.set(
      addition.path,
      isCmsReferenceTextPath(addition.path)
        ? {
            kind: 'text',
            contents: decodeBase64Text(addition.path, addition.contents),
          }
        : { kind: 'media' },
    )
  }

  return projected
}

function collectContentReferences({
  authorIds,
  blogSlugs,
  blogReferences,
  contentReferences,
  contents,
  path,
  tagIds,
  tagSlugs,
}: {
  authorIds: Set<string>
  blogSlugs: Map<string, string>
  blogReferences: Array<{ author: string; tags: string[]; path: string }>
  contentReferences: ContentReference[]
  contents: string
  path: string
  tagIds: Set<string>
  tagSlugs: Map<string, string>
}) {
  if (path === 'src/content/site/main.json') {
    const site = siteContentSchema.parse(JSON.parse(contents))

    contentReferences.push(
      { sourcePath: path, value: site.icon },
      { sourcePath: path, value: site.cover },
      ...site.headerLinks.map(({ href }) => ({
        sourcePath: path,
        value: href,
      })),
      ...site.socialLinks.map(({ href }) => ({
        sourcePath: path,
        value: href,
      })),
      ...site.homePillars.flatMap(({ href, image }) => [
        { sourcePath: path, value: href },
        { sourcePath: path, value: image },
      ]),
    )
    return
  }

  if (path.startsWith('src/content/authors/')) {
    const author = authorContentSchema.parse(JSON.parse(contents))

    authorIds.add(author.id)
    contentReferences.push(
      { sourcePath: path, value: author.avatar },
      ...author.links.map(({ href }) => ({ sourcePath: path, value: href })),
    )
    return
  }

  if (path.startsWith('src/content/tags/')) {
    const tag = tagContentSchema.parse(JSON.parse(contents))

    tagIds.add(tag.id)
    registerUniqueRouteSlug('tag', tag.slug, path, tagSlugs)
    return
  }

  if (path.startsWith('src/content/blog/')) {
    const document = parseBlogDocument(contents)
    const blog = blogContentSchema.parse(document.frontmatter)
    const effectiveSlug =
      blog.slug?.trim() || path.slice('src/content/blog/'.length, -'.md'.length)

    if (!contentRouteSlugSchema.safeParse(effectiveSlug).success) {
      throw new GitHubApiError(`${path}: blog route slugが不正です。`, 422)
    }

    registerUniqueRouteSlug('blog', effectiveSlug, path, blogSlugs)
    blogReferences.push({
      author: blog.author,
      tags: blog.tags,
      path,
    })
    contentReferences.push(
      { sourcePath: path, value: blog.image },
      ...(blog.gallery?.images.map(({ src }) => ({
        sourcePath: path,
        value: src,
      })) ?? []),
      { sourcePath: path, value: blog.youtube?.url },
      ...blog.linkCards.map(({ href }) => ({ sourcePath: path, value: href })),
      ...findMarkdownDestinations(stripMarkdownCode(document.body)).map(
        (value) => ({ markdown: true, sourcePath: path, value }),
      ),
    )
    return
  }

  if (path.startsWith('src/content/art/')) {
    const art = artContentSchema.parse(JSON.parse(contents))

    contentReferences.push(
      { sourcePath: path, value: art.sourceUrl },
      { sourcePath: path, value: art.image },
    )
    return
  }

  if (path.startsWith('src/content/modeling/')) {
    const modeling = modelingContentSchema.parse(JSON.parse(contents))

    contentReferences.push(
      { sourcePath: path, value: modeling.boothUrl },
      { sourcePath: path, value: modeling.youtubeUrl },
      { sourcePath: path, value: modeling.xUrl },
      { sourcePath: path, value: modeling.tryOnUrl },
      { sourcePath: path, value: modeling.image },
      ...modeling.related.map(({ href }) => ({
        sourcePath: path,
        value: href,
      })),
    )
    return
  }

  if (path.startsWith('src/content/campaigns/')) {
    const campaign = campaignContentSchema.parse(JSON.parse(contents))

    contentReferences.push({ sourcePath: path, value: campaign.href })
  }
}

function registerUniqueRouteSlug(
  kind: 'blog' | 'tag',
  slug: string,
  path: string,
  routes: Map<string, string>,
) {
  const existingPath = routes.get(slug)

  if (existingPath && existingPath !== path) {
    throw new GitHubApiError(
      `${path}: ${kind} route slug「${slug}」が${existingPath}と重複しています。`,
      422,
    )
  }

  routes.set(slug, path)
}

function parseBlogDocument(contents: string) {
  const match = FRONTMATTER_PATTERN.exec(contents)

  if (!match) {
    throw new GitHubApiError('CMS記事のfrontmatterを解析できません。', 422)
  }

  return {
    frontmatter: parseYaml(match[1], {
      json: false,
      schema: JSON_SCHEMA,
    }),
    body: contents.slice(match[0].length),
  }
}

function resolveLocalMediaPath(value: string, markdown: boolean) {
  const normalizedDestination = markdown
    ? normalizeMarkdownDestination(value)
    : value
  const inputPath = normalizedDestination.split(/[?#]/, 1)[0]
  const decodedInputPath = decodeUrlPath(inputPath)
  const lookedLikeLocal =
    inputPath.startsWith(LOCAL_MEDIA_URL_PREFIX) ||
    decodedInputPath?.startsWith(LOCAL_MEDIA_URL_PREFIX) === true
  let url: URL

  try {
    url = new URL(normalizedDestination, BASE_URL)
  } catch {
    if (lookedLikeLocal) throwInvalidLocalMediaReference(value)
    return null
  }

  if (url.origin !== BASE_URL) return null

  const decodedPath = decodeUrlPath(url.pathname)

  if (!decodedPath?.startsWith(LOCAL_MEDIA_URL_PREFIX)) {
    if (lookedLikeLocal) throwInvalidLocalMediaReference(value)
    return null
  }

  if (/%(?:2f|5c)/i.test(url.pathname)) {
    throwInvalidLocalMediaReference(value)
  }

  const mediaPath = `public${decodedPath}`

  if (
    !mediaPath.startsWith(LOCAL_MEDIA_PATH_PREFIX) ||
    normalizeCmsPath(mediaPath) !== mediaPath ||
    !isCmsReferenceStatePath(mediaPath)
  ) {
    throwInvalidLocalMediaReference(value)
  }

  return mediaPath
}

function decodeUrlPath(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function throwInvalidLocalMediaReference(value: string): never {
  throw new GitHubApiError(`CMS内の画像参照が不正です: ${value}`, 422)
}

function decodeBase64Text(path: string, contents: string) {
  try {
    const binary = atob(contents)
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    )

    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new GitHubApiError(`${path}: UTF-8として解析できません。`, 422)
  }
}
