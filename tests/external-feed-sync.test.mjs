import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeJsonIfChanged } from '../scripts/sync-external-feeds.mjs'

test('絵ページはX公式タイムラインを作品ギャラリーより先に表示する', async () => {
  const source = await fs.readFile(
    new URL('../src/pages/art.astro', import.meta.url),
    'utf8',
  )
  const liveSectionIndex = source.indexOf('art-live-section')
  const gallerySectionIndex = source.indexOf('art-gallery-section')

  assert.notEqual(liveSectionIndex, -1)
  assert.notEqual(gallerySectionIndex, -1)
  assert.ok(liveSectionIndex < gallerySectionIndex)
  assert.match(source, /class="twitter-timeline"/)
  assert.match(source, /src="https:\/\/platform\.x\.com\/widgets\.js"/)
})

test('外部フィードは表示内容が変わった場合だけ書き換える', async (t) => {
  const outputDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'homepage-hatt-external-feed-'),
  )
  const fileName = 'feed.json'
  const filePath = path.join(outputDirectory, fileName)

  t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }))

  const initial = {
    source: 'fixture',
    syncedAt: '2026-01-01T00:00:00.000Z',
    works: [
      {
        ncode: 'N0000AA',
        title: '作品名',
        updatedAt: '2026-01-01T00:00:00',
        globalPoint: 1,
      },
    ],
    videos: [
      {
        videoId: 'video-1',
        title: '動画名',
        updatedAt: '2026-01-01T00:00:00Z',
        views: 10,
      },
    ],
  }

  assert.equal(
    await writeJsonIfChanged(fileName, initial, {
      outputDirectory,
      now: () => '2026-02-01T00:00:00.000Z',
    }),
    true,
  )

  const firstWrite = await fs.readFile(filePath, 'utf8')
  assert.equal(JSON.parse(firstWrite).syncedAt, '2026-02-01T00:00:00.000Z')

  const volatileChangesOnly = {
    ...initial,
    syncedAt: '2026-03-01T00:00:00.000Z',
    works: [
      {
        ...initial.works[0],
        updatedAt: '2026-03-01T00:00:00',
        globalPoint: 99,
      },
    ],
    videos: [
      {
        ...initial.videos[0],
        updatedAt: '2026-03-01T00:00:00Z',
        views: 999,
      },
    ],
  }

  assert.equal(
    await writeJsonIfChanged(fileName, volatileChangesOnly, {
      outputDirectory,
      now: () => '2026-03-01T00:00:00.000Z',
    }),
    false,
  )
  assert.equal(await fs.readFile(filePath, 'utf8'), firstWrite)

  const meaningfulChange = {
    ...volatileChangesOnly,
    videos: [{ ...volatileChangesOnly.videos[0], title: '更新後の動画名' }],
  }

  assert.equal(
    await writeJsonIfChanged(fileName, meaningfulChange, {
      outputDirectory,
      now: () => '2026-04-01T00:00:00.000Z',
    }),
    true,
  )

  const finalWrite = JSON.parse(await fs.readFile(filePath, 'utf8'))
  assert.equal(finalWrite.syncedAt, '2026-04-01T00:00:00.000Z')
  assert.equal(finalWrite.videos[0].title, '更新後の動画名')
  assert.equal(finalWrite.videos[0].views, 999)
})
