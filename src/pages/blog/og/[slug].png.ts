import type { APIContext } from 'astro'
import sharp from 'sharp'
import { getBlogSlug, getPosts } from '@/utils/blog'
import { createOgSvg } from '@/utils/og'

export async function getStaticPaths() {
  const posts = await getPosts()
  return posts.map((post) => ({
    params: { slug: getBlogSlug(post) },
    props: { post },
  }))
}

export async function GET({ props, site }: APIContext) {
  const post = props.post
  const image =
    post.data.image && site
      ? new URL(post.data.image, site).toString()
      : undefined
  const svg = createOgSvg({
    title: post.data.title,
    description: post.data.description,
    image,
  })
  const png = await sharp(Buffer.from(svg)).png().toBuffer()

  return new Response(png, {
    headers: {
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Type': 'image/png',
    },
  })
}
