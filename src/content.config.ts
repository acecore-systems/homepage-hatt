import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'
import { parseCmsDateTime } from './utils/publication-window'

const linkSchema = z.object({
  label: z.string(),
  href: z.string(),
})
const richImageSchema = z.object({
  src: z.string(),
  alt: z.string().default(''),
  caption: z.string().optional(),
})
const calloutSchema = z.object({
  title: z.string().optional(),
  text: z.string().optional(),
  tone: z.enum(['cyan', 'ember', 'mint', 'pollen']).default('cyan'),
})
const timelineSchema = z.object({
  title: z.string().optional(),
  items: z
    .array(
      z.object({
        title: z.string(),
        text: z.string().optional(),
        date: z.string().optional(),
      }),
    )
    .default([]),
})
const compareTableSchema = z.object({
  title: z.string().optional(),
  columns: z.array(z.string()).default([]),
  rows: z
    .array(
      z.object({
        label: z.string().optional(),
        cells: z.array(z.string()).default([]),
      }),
    )
    .default([]),
})
const checklistSchema = z.object({
  title: z.string().optional(),
  items: z.array(z.string()).default([]),
})
const gallerySchema = z.object({
  title: z.string().optional(),
  images: z.array(richImageSchema).default([]),
})
const youtubeSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  caption: z.string().optional(),
})
const faqSchema = z.object({
  title: z.string().optional(),
  items: z
    .array(
      z.object({
        question: z.string(),
        answer: z.string(),
      }),
    )
    .default([]),
})
const pullQuoteSchema = z.object({
  quote: z.string().optional(),
  source: z.string().optional(),
})
const cmsDate = z.preprocess(
  (value) => parseCmsDateTime(value) ?? value,
  z.date(),
)

const blog = defineCollection({
  loader: glob({
    base: './src/content/blog',
    pattern: '**/*.md',
  }),
  schema: z.object({
    title: z.string(),
    slug: z.string().optional(),
    description: z.string(),
    date: cmsDate,
    lastUpdated: cmsDate.optional(),
    tags: z.array(z.string()).default([]),
    author: z.string(),
    image: z.string().optional(),
    legacySlugs: z.array(z.string()).default([]),
    callout: calloutSchema.optional(),
    timeline: timelineSchema.optional(),
    compareTable: compareTableSchema.optional(),
    checklist: checklistSchema.optional(),
    gallery: gallerySchema.optional(),
    youtube: youtubeSchema.optional(),
    faq: faqSchema.optional(),
    linkCards: z
      .array(linkSchema.extend({ description: z.string().optional() }))
      .default([]),
    pullQuote: pullQuoteSchema.optional(),
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
    order: z.number().default(100),
    priceLabel: z.string().optional(),
    boothUrl: z.string().optional(),
    youtubeUrl: z.string().optional(),
    xUrl: z.string().optional(),
    tryOnUrl: z.string().optional(),
    image: z.string().optional(),
    features: z.array(z.string()).default([]),
    specs: z.array(z.string()).default([]),
    requirements: z.array(z.string()).default([]),
    related: z.array(linkSchema).default([]),
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
