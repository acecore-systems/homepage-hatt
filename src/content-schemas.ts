import { z } from 'zod'

const CONTENT_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?$/
const CONTENT_ROUTE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
const MAX_CONTENT_ROUTE_SLUG_LENGTH = 120

function isSafeContentUrl(value: string) {
  if (
    value !== value.trim() ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false
  }

  if (value.startsWith('/')) {
    return !value.startsWith('//') && !value.includes('\\')
  }

  if (value.startsWith('#')) return true

  try {
    const url = new URL(value)

    return (
      (url.protocol === 'https:' ||
        url.protocol === 'mailto:' ||
        url.protocol === 'tel:') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

const contentUrlSchema = z
  .string()
  .refine(isSafeContentUrl, '安全なHTTPSまたはサイト内URLを指定してください。')
const optionalContentUrlSchema = z
  .union([contentUrlSchema, z.literal('')])
  .optional()
const contentDateSchema = z
  .string()
  .refine(
    (value) =>
      CONTENT_DATETIME_PATTERN.test(value.trim()) &&
      Number.isFinite(Date.parse(value)),
    '日時は時刻を含む YYYY-MM-DDTHH:mm 形式で指定してください。',
  )
export const contentRouteSlugSchema = z
  .string()
  .min(1)
  .max(MAX_CONTENT_ROUTE_SLUG_LENGTH)
  .regex(CONTENT_ROUTE_SLUG_PATTERN)

const linkSchema = z
  .object({
    label: z.string(),
    href: contentUrlSchema,
  })
  .strict()
const richImageSchema = z
  .object({
    src: contentUrlSchema,
    alt: z.string().trim().min(1),
    caption: z.string().optional(),
  })
  .strict()
const calloutSchema = z
  .object({
    title: z.string().optional(),
    text: z.string().optional(),
    tone: z.enum(['cyan', 'ember', 'mint', 'pollen']).default('cyan'),
  })
  .strict()
const timelineSchema = z
  .object({
    title: z.string().optional(),
    items: z
      .array(
        z
          .object({
            title: z.string(),
            text: z.string().optional(),
            date: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
const compareTableSchema = z
  .object({
    title: z.string().optional(),
    columns: z.array(z.string()).default([]),
    rows: z
      .array(
        z
          .object({
            label: z.string().optional(),
            cells: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
const checklistSchema = z
  .object({
    title: z.string().optional(),
    items: z.array(z.string()).default([]),
  })
  .strict()
const gallerySchema = z
  .object({
    title: z.string().optional(),
    images: z.array(richImageSchema).default([]),
  })
  .strict()
const youtubeSchema = z
  .object({
    url: optionalContentUrlSchema,
    title: z.string().optional(),
    caption: z.string().optional(),
  })
  .strict()
const faqSchema = z
  .object({
    title: z.string().optional(),
    items: z
      .array(
        z
          .object({
            question: z.string(),
            answer: z.string(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
const pullQuoteSchema = z
  .object({
    quote: z.string().optional(),
    source: z.string().optional(),
  })
  .strict()

export const blogContentSchema = z
  .object({
    title: z.string(),
    slug: contentRouteSlugSchema.optional(),
    description: z.string(),
    date: contentDateSchema,
    lastUpdated: contentDateSchema.optional(),
    tags: z.array(z.string()).default([]),
    author: z.string(),
    image: contentUrlSchema.optional(),
    imageAlt: z.string().trim().min(1).optional(),
    legacySlugs: z.array(z.string()).default([]),
    callout: calloutSchema.optional(),
    timeline: timelineSchema.optional(),
    compareTable: compareTableSchema.optional(),
    checklist: checklistSchema.optional(),
    gallery: gallerySchema.optional(),
    youtube: youtubeSchema.optional(),
    faq: faqSchema.optional(),
    linkCards: z
      .array(
        linkSchema
          .extend({
            description: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    pullQuote: pullQuoteSchema.optional(),
  })
  .strict()

export const tagContentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: contentRouteSlugSchema,
    description: z.string().optional(),
  })
  .strict()

export const authorContentSchema = z
  .object({
    id: contentRouteSlugSchema,
    name: z.string(),
    bio: z.string(),
    avatar: contentUrlSchema.optional(),
    links: z.array(linkSchema).default([]),
  })
  .strict()

export const artContentSchema = z
  .object({
    sourceUrl: contentUrlSchema,
    image: contentUrlSchema,
  })
  .strict()

export const modelingContentSchema = z
  .object({
    title: z.string(),
    kind: z.string(),
    summary: z.string(),
    order: z.number().default(100),
    priceLabel: z.string().optional(),
    boothUrl: optionalContentUrlSchema,
    youtubeUrl: optionalContentUrlSchema,
    xUrl: optionalContentUrlSchema,
    tryOnUrl: optionalContentUrlSchema,
    image: contentUrlSchema.optional(),
    features: z.array(z.string()).default([]),
    specs: z.array(z.string()).default([]),
    requirements: z.array(z.string()).default([]),
    related: z.array(linkSchema).default([]),
    featured: z.boolean().default(false),
  })
  .strict()

export const campaignContentSchema = z
  .object({
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
    href: optionalContentUrlSchema,
    ctaLabel: z.string().optional(),
    icon: z.string().optional(),
    tone: z.enum(['cyan', 'ember', 'mint', 'pollen']).default('cyan'),
    order: z.number().default(100),
    startsAt: contentDateSchema.optional(),
    endsAt: contentDateSchema.optional(),
  })
  .strict()

export const siteContentSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    icon: contentUrlSchema,
    cover: contentUrlSchema,
    adsenseClientId: z.string().optional(),
    turnstileSiteKey: z.string().optional(),
    adsenseSlotId: z.string().optional(),
    adsenseInlineSlotId: z.string().optional(),
    headerLinks: z.array(linkSchema).default([]),
    socialLinks: z.array(linkSchema).default([]),
    homePillars: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          eyebrow: z.string(),
          title: z.string(),
          description: z.string(),
          href: contentUrlSchema,
          cta: z.string(),
          image: contentUrlSchema,
          imageAlt: z.string().trim().min(1),
          tone: z.enum(['cyan', 'ember', 'mint']),
        })
        .strict(),
    ),
  })
  .strict()
