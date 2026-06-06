import sitemap from '@astrojs/sitemap'
import UnoCSS from '@unocss/astro'
import { unified } from '@astrojs/markdown-remark'
import rehypeExternalLinks from 'rehype-external-links'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://hatt.acecore.net',
  integrations: [
    UnoCSS(),
    sitemap({
      filter: (page) =>
        ![
          /\/blog\/og\//,
          /\/blog\/article\/\d{8}_/,
          /\/blog\/tag\//,
          /\/blog\/archive\//,
          /\/blog\/author\//,
          /\/blog\/search\//,
        ].some((pattern) => pattern.test(page)),
    }),
  ],
  markdown: {
    processor: unified({
      rehypePlugins: [
        [
          rehypeExternalLinks,
          {
            rel: ['noopener', 'noreferrer'],
            target: '_blank',
          },
        ],
      ],
    }),
  },
  output: 'static',
})
