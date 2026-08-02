import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [coursePage, commentsComponent] = await Promise.all([
  readFile(
    new URL('../src/pages/modeling-course.astro', import.meta.url),
    'utf8',
  ),
  readFile(
    new URL('../src/components/BlogComments.astro', import.meta.url),
    'utf8',
  ),
])

for (const [name, source] of [
  ['無料体験フォーム', coursePage],
  ['ブログコメントフォーム', commentsComponent],
]) {
  test(`${name}は期限切れのTurnstileを自動的に再取得する`, () => {
    assert.match(source, /'expired-callback': resetTurnstile,/u)
  })

  test(`${name}はトークン未取得時にTurnstileをリセットする`, () => {
    const noTokenBranch = source.slice(
      source.indexOf('if (!turnstileToken)'),
      source.indexOf('if (submit) submit.disabled = true'),
    )

    assert.match(noTokenBranch, /resetTurnstile\(\)/u)
  })
}
