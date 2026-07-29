import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
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
  site,
  tags,
}
