import rss from '@astrojs/rss'
import type { APIContext } from 'astro'
import { getBlogPath, getPosts, getSiteConfig } from '@/utils/blog'

export async function GET(context: APIContext) {
  const site = await getSiteConfig()
  const posts = await getPosts()

  return rss({
    title: `${site.name} ブログ`,
    description: site.description,
    site: context.site ?? 'https://hatt.acecore.net',
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      link: getBlogPath(post),
      pubDate: post.data.date,
    })),
  })
}
