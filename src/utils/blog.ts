import { getCollection, getEntry, type CollectionEntry } from 'astro:content'

export type BlogPost = CollectionEntry<'blog'>
export type TagEntry = CollectionEntry<'tags'>
export type AuthorEntry = CollectionEntry<'authors'>

export function getBlogSlug(post: BlogPost) {
  const fallback = post.id.replace(/\.md$/, '').replace(/\/index$/, '')
  return 'slug' in post && typeof post.slug === 'string' ? post.slug : fallback
}

export function getBlogPath(post: BlogPost) {
  return `/blog/article/${getBlogSlug(post)}/`
}

export async function getSiteConfig() {
  const site = await getEntry('site', 'main')
  if (!site) {
    throw new Error('Missing site/main.json')
  }
  return site.data
}

export async function getPosts() {
  const posts = await getCollection('blog')
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime())
}

export async function getTags() {
  return getCollection('tags')
}

export async function getAuthors() {
  return getCollection('authors')
}

export async function getTagMap() {
  const tags = await getTags()
  return new Map(tags.map((tag) => [tag.data.id, tag.data]))
}

export async function getAuthorMap() {
  const authors = await getAuthors()
  return new Map(authors.map((author) => [author.data.id, author.data]))
}

export async function getTagStats() {
  const posts = await getPosts()
  const tags = await getTags()

  return tags
    .map((tag) => ({
      ...tag.data,
      count: posts.filter((post) => post.data.tags.includes(tag.data.id))
        .length,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'))
}

export async function getArchiveStats() {
  const posts = await getPosts()
  const years = new Map<number, number>()

  for (const post of posts) {
    const year = post.data.date.getFullYear()
    years.set(year, (years.get(year) ?? 0) + 1)
  }

  return [...years.entries()]
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => b.year - a.year)
}

export function getPostsByTag(posts: BlogPost[], tagId: string) {
  return posts.filter((post) => post.data.tags.includes(tagId))
}

export function getPostsByAuthor(posts: BlogPost[], authorId: string) {
  return posts.filter((post) => post.data.author === authorId)
}

export function getPostsByYear(posts: BlogPost[], year: number) {
  return posts.filter((post) => post.data.date.getFullYear() === year)
}

export function getAdjacentPosts(posts: BlogPost[], current: BlogPost) {
  const index = posts.findIndex(
    (post) => getBlogSlug(post) === getBlogSlug(current),
  )

  return {
    previous: index >= 0 ? posts[index + 1] : undefined,
    next: index > 0 ? posts[index - 1] : undefined,
  }
}

export function getRelatedPosts(
  posts: BlogPost[],
  current: BlogPost,
  limit = 3,
) {
  const currentSlug = getBlogSlug(current)
  const currentTags = new Set(current.data.tags)

  return posts
    .filter((post) => getBlogSlug(post) !== currentSlug)
    .map((post) => ({
      post,
      score: post.data.tags.filter((tag) => currentTags.has(tag)).length,
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.post.data.date.getTime() - a.post.data.date.getTime(),
    )
    .slice(0, limit)
    .map((entry) => entry.post)
}
