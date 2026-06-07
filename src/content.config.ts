import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

const linkSchema = z.object({
  label: z.string(),
  href: z.string(),
})

const blog = defineCollection({
  loader: glob({
    base: './src/content/blog',
    pattern: '**/*.md',
  }),
  schema: z.object({
    title: z.string(),
    slug: z.string().optional(),
    description: z.string(),
    date: z.coerce.date(),
    lastUpdated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    author: z.string(),
    image: z.string().optional(),
    legacySlugs: z.array(z.string()).default([]),
  }),
})

const tags = defineCollection({
  loader: glob({
    base: './src/content/tags',
    pattern: '**/*.json',
  }),
  schema: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().optional(),
  }),
})

const authors = defineCollection({
  loader: glob({
    base: './src/content/authors',
    pattern: '**/*.json',
  }),
  schema: z.object({
    id: z.string(),
    name: z.string(),
    bio: z.string(),
    avatar: z.string().optional(),
    links: z.array(linkSchema).default([]),
  }),
})

const modeling = defineCollection({
  loader: glob({
    base: './src/content/modeling',
    pattern: '**/*.json',
  }),
  schema: z.object({
    title: z.string(),
    kind: z.string(),
    summary: z.string(),
    priceLabel: z.string().optional(),
    boothUrl: z.string().optional(),
    youtubeUrl: z.string().optional(),
    xUrl: z.string().optional(),
    image: z.string().optional(),
    featured: z.boolean().default(false),
  }),
})

const campaigns = defineCollection({
  loader: glob({
    base: './src/content/campaigns',
    pattern: '**/*.json',
  }),
  schema: z.object({
    id: z.string(),
    enabled: z.boolean().default(false),
    kind: z.enum(['banner', 'notice']).default('notice'),
    placement: z
      .enum([
        'global',
        'home-after-hero',
        'blog-after-hero',
        'blog-article-after-header',
        'modeling-after-hero',
        'profile-after-hero',
      ])
      .default('global'),
    title: z.string(),
    body: z.string().optional(),
    href: z.string().optional(),
    ctaLabel: z.string().optional(),
    icon: z.string().optional(),
    tone: z.enum(['cyan', 'ember', 'mint', 'pollen']).default('cyan'),
    order: z.number().default(100),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
  }),
})

const site = defineCollection({
  loader: glob({
    base: './src/content/site',
    pattern: '**/*.json',
  }),
  schema: z.object({
    name: z.string(),
    description: z.string(),
    icon: z.string(),
    cover: z.string(),
    adsenseClientId: z.string().optional(),
    turnstileSiteKey: z.string().optional(),
    adsenseSlotId: z.string().optional(),
    adsenseInlineSlotId: z.string().optional(),
    headerLinks: z.array(linkSchema).default([]),
    socialLinks: z.array(linkSchema).default([]),
    homePillars: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        eyebrow: z.string(),
        title: z.string(),
        description: z.string(),
        href: z.string(),
        cta: z.string(),
        image: z.string(),
        tone: z.enum(['cyan', 'ember', 'mint']),
      }),
    ),
  }),
})

export const collections = {
  authors,
  blog,
  campaigns,
  modeling,
  site,
  tags,
}
