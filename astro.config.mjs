import sitemap from '@astrojs/sitemap'
import UnoCSS from '@unocss/astro'
import { unified } from '@astrojs/markdown-remark'
import rehypeExternalLinks from 'rehype-external-links'
import rehypeOptimizeImages from './src/utils/rehype-optimize-images'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://hatt.acecore.net',
  integrations: [
    UnoCSS(),
    sitemap({
      lastmod: new Date(),
      filter: (page) =>
        ![
          /\/blog\/og\//,
          /\/blog\/article\/\d{8}_/,
          /\/blog\/tag\//,
          /\/blog\/archive\//,
          /\/blog\/author\//,
          /\/blog\/search\//,
          /\/shop\/admin\//,
          /\/shop\/checkout\//,
          /\/shop\/catalog\.json/,
        ].some((pattern) => pattern.test(page)),
      serialize(item) {
        if (item.url === 'https://hatt.acecore.net/') {
          item.changefreq = 'weekly'
          item.priority = 1.0
        } else if (
          item.url.includes('/blog/article/') &&
          !/\/blog\/article\/\d{8}_/.test(item.url)
        ) {
          item.changefreq = 'monthly'
          item.priority = 0.8
        } else {
          item.changefreq = 'monthly'
          item.priority = 0.6
        }
        return item
      },
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
        rehypeOptimizeImages,
      ],
    }),
  },
  output: 'static',
})
