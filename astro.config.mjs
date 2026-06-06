import sitemap from '@astrojs/sitemap'
import UnoCSS from '@unocss/astro'
import rehypeExternalLinks from 'rehype-external-links'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://hatt.acecore.net',
  integrations: [
    UnoCSS(),
    sitemap({
      filter: (page) => !page.includes('/blog/og/'),
    }),
  ],
  markdown: {
    rehypePlugins: [
      [
        rehypeExternalLinks,
        {
          rel: ['noopener', 'noreferrer'],
          target: '_blank',
        },
      ],
    ],
  },
  output: 'static',
})
