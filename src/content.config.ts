import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'zod'
import {
  artContentSchema,
  authorContentSchema,
  blogContentSchema,
  campaignContentSchema,
  modelingContentSchema,
  siteContentSchema,
  tagContentSchema,
} from './content-schemas'
import { parseCmsDateTime } from './utils/publication-window'

const richImageSchema = z
  .object({
    src: z.string(),
    alt: z.string().trim().min(1),
    caption: z.string().optional(),
  })
  .strict()
const shopCategorySchema = z.enum(['picture', 'novel', 'modeling', 'goods'])
const shopStatusSchema = z.enum(['draft', 'published', 'sold_out'])
const fulfillmentTypeSchema = z.enum(['digital', 'manual', 'physical'])
const blog = defineCollection({
  loader: glob({
    base: './src/content/blog',
    pattern: '**/*.md',
  }),
  schema: blogContentSchema.transform((data) => ({
    ...data,
    date: parseRequiredCmsDate(data.date),
    ...(data.lastUpdated
      ? { lastUpdated: parseRequiredCmsDate(data.lastUpdated) }
      : {}),
  })),
})

const tags = defineCollection({
  loader: glob({
    base: './src/content/tags',
    pattern: '**/*.json',
  }),
  schema: tagContentSchema,
})

const authors = defineCollection({
  loader: glob({
    base: './src/content/authors',
    pattern: '**/*.json',
  }),
  schema: authorContentSchema,
})

const art = defineCollection({
  loader: glob({
    base: './src/content/art',
    pattern: '**/*.json',
  }),
  schema: artContentSchema,
})

const modeling = defineCollection({
  loader: glob({
    base: './src/content/modeling',
    pattern: '**/*.json',
  }),
  schema: modelingContentSchema,
})

const campaigns = defineCollection({
  loader: glob({
    base: './src/content/campaigns',
    pattern: '**/*.json',
  }),
  schema: campaignContentSchema,
})

const products = defineCollection({
  loader: glob({
    base: './src/content/products',
    pattern: '**/*.json',
  }),
  schema: z.object({
    slug: z.string(),
    title: z.string(),
    category: shopCategorySchema,
    summary: z.string(),
    description: z.string().optional(),
    images: z.array(richImageSchema).default([]),
    priceJpy: z.number().int().nonnegative(),
    status: shopStatusSchema.default('draft'),
    fulfillmentType: fulfillmentTypeSchema,
    stock: z.number().int().nonnegative().default(0),
    maxQuantity: z.number().int().positive().default(1),
    r2ObjectKey: z.string().optional(),
    shippingProfileId: z.string().optional(),
    taxCode: z.string().optional(),
    externalUrl: z.string().optional(),
    features: z.array(z.string()).default([]),
    order: z.number().default(100),
    featured: z.boolean().default(false),
  }),
})

const shippingProfileSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  amountJpy: z.number().int().nonnegative().default(0),
  freeAboveJpy: z.number().int().nonnegative().optional(),
  countries: z.array(z.string()).default(['JP']),
})

const shopSettings = defineCollection({
  loader: glob({
    base: './src/content/shop-settings',
    pattern: '**/*.json',
  }),
  schema: z.object({
    id: z.string().default('main'),
    enabled: z.boolean().default(true),
    checkoutEnabled: z.boolean().default(false),
    currency: z.literal('JPY').default('JPY'),
    stripeTaxEnabled: z.boolean().default(true),
    stripeConnectedAccountId: z.string().optional(),
    platformFeeBasisPoints: z.number().int().min(0).max(9999).default(0),
    platformFeeFixedJpy: z.number().int().nonnegative().default(0),
    allowedCountries: z.array(z.string()).default(['JP']),
    shippingProfiles: z.array(shippingProfileSchema).default([]),
    businessName: z.string().optional(),
    sellerName: z.string().optional(),
    sellerAddress: z.string().optional(),
    sellerPhone: z.string().optional(),
    sellerEmail: z.string().optional(),
    contactUrl: z.string().optional(),
    returnsPolicy: z.string().optional(),
    privacyPolicy: z.string().optional(),
    terms: z.string().optional(),
  }),
})

const site = defineCollection({
  loader: glob({
    base: './src/content/site',
    pattern: '**/*.json',
  }),
  schema: siteContentSchema,
})

function parseRequiredCmsDate(value: string) {
  const date = parseCmsDateTime(value)

  if (!date) {
    throw new Error(`Invalid date value in content frontmatter: ${value}`)
  }

  return date
}

export const collections = {
  authors,
  art,
  blog,
  campaigns,
  modeling,
  products,
  site,
  shopSettings,
  tags,
}
