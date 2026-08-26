import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const sourceDirectory = new URL('../src/', import.meta.url)

async function collectAstroSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const sources = await Promise.all(
    entries.map(async (entry) => {
      const entryUrl = new URL(
        `${entry.name}${entry.isDirectory() ? '/' : ''}`,
        directory,
      )
      if (entry.isDirectory()) return collectAstroSources(entryUrl)
      if (!entry.name.endsWith('.astro')) return []
      return [await readFile(entryUrl, 'utf8')]
    }),
  )

  return sources.flat()
}

const [packageJson, astroConfig, globalStyles, astroSources] =
  await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(
      JSON.parse,
    ),
    readFile(new URL('../astro.config.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8'),
    collectAstroSources(sourceDirectory),
  ])

test('Tailwind CSS v4を唯一のUIコンパイラとして設定する', () => {
  assert.ok(packageJson.devDependencies.tailwindcss)
  assert.ok(packageJson.devDependencies['@tailwindcss/vite'])
  assert.ok(packageJson.devDependencies['@iconify/tailwind4'])
  assert.equal(packageJson.devDependencies.unocss, undefined)
  assert.equal(packageJson.devDependencies['@unocss/astro'], undefined)
  assert.doesNotMatch(astroConfig, /UnoCSS|@unocss/u)
  assert.match(astroConfig, /@tailwindcss\/vite/u)
})

test('共通トークンとPreflight方針をCSSで明示する', () => {
  assert.match(globalStyles, /@theme\s*\{/u)
  assert.match(globalStyles, /--color-ink-900:/u)
  assert.match(globalStyles, /--font-sans:/u)
  assert.match(globalStyles, /tailwindcss\/theme\.css/u)
  assert.match(globalStyles, /tailwindcss\/utilities\.css/u)
  assert.doesNotMatch(globalStyles, /tailwindcss\/preflight\.css/u)
  assert.match(globalStyles, /@plugin "@iconify\/tailwind4";/u)
  assert.match(globalStyles, /:focus-visible/u)
  assert.match(globalStyles, /prefers-reduced-motion: reduce/u)
})

test('Astro画面はUnoCSSのLucideクラスを残さない', () => {
  const source = astroSources.join('\n')
  assert.doesNotMatch(source, /i-lucide-/u)
  assert.match(source, /icon-\[lucide--/u)
})
