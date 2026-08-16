import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  parseNarouPayload,
  parseYoutubeFeed,
  writeJsonIfChanged,
} from '../scripts/sync-external-feeds.mjs'

const fixtureNow = () => '2026-08-17T00:00:00.000Z'

test('小説APIの空・欠落レスポンスでは既存スナップショットを上書きしない', () => {
  assert.throws(
    () => parseNarouPayload(JSON.stringify([{ allcount: 0 }])),
    /no published works/,
  )
  assert.throws(
    () =>
      parseNarouPayload(
        JSON.stringify([
          { allcount: 2 },
          {
            title: '作品名',
            ncode: 'N0000AA',
          },
        ]),
      ),
    /1 of 2 expected works/,
  )
})

test('小説APIの完全なレスポンスだけをスナップショット化する', () => {
  const result = parseNarouPayload(
    JSON.stringify([
      { allcount: 1 },
      {
        title: '作品名',
        ncode: 'N0000AA',
        story: 'あらすじ',
        general_firstup: '2026-08-01 12:00:00',
        general_lastup: '2026-08-02 13:00:00',
        general_all_no: 1,
        length: 1200,
        time: 3,
        end: 1,
        isstop: 0,
        novel_type: 2,
      },
    ]),
    { now: fixtureNow },
  )

  assert.equal(result.syncedAt, fixtureNow())
  assert.equal(result.works.length, 1)
  assert.equal(result.works[0].url, 'https://ncode.syosetu.com/n0000aa/')
})

test('YouTube RSSの空・不正エントリでは既存スナップショットを上書きしない', () => {
  const emptyFeed = `
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
      <yt:channelId>zEhXHKDoOrvjFUcIe5q3jA</yt:channelId>
    </feed>
  `
  const invalidEntry = `
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
      <yt:channelId>zEhXHKDoOrvjFUcIe5q3jA</yt:channelId>
      <entry><title>動画名</title></entry>
    </feed>
  `
  const differentChannelFeed = emptyFeed.replace(
    'zEhXHKDoOrvjFUcIe5q3jA',
    'different-channel',
  )

  assert.throws(() => parseYoutubeFeed(emptyFeed), /returned no videos/)
  assert.throws(() => parseYoutubeFeed(invalidEntry), /videoId is missing/)
  assert.throws(
    () => parseYoutubeFeed(differentChannelFeed),
    /different channel/,
  )
})

test('YouTube RSSの完全なエントリだけをスナップショット化する', () => {
  const feed = `
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
      <yt:channelId>zEhXHKDoOrvjFUcIe5q3jA</yt:channelId>
      <entry>
        <yt:videoId>video-1</yt:videoId>
        <title>動画名</title>
        <published>2026-08-16T00:00:00+00:00</published>
        <media:group>
          <media:description>説明</media:description>
        </media:group>
      </entry>
    </feed>
  `
  const result = parseYoutubeFeed(feed, { now: fixtureNow })

  assert.equal(result.syncedAt, fixtureNow())
  assert.equal(result.videos.length, 1)
  assert.equal(result.videos[0].videoId, 'video-1')
})

test('絵ページは画像ギャラリーだけを表示しXタイムラインを読み込まない', async () => {
  const source = await fs.readFile(
    new URL('../src/pages/art.astro', import.meta.url),
    'utf8',
  )

  assert.match(source, /class="art-grid"/)
  assert.doesNotMatch(source, /class="twitter-timeline"/)
  assert.doesNotMatch(source, /platform\.x\.com\/widgets\.js/)
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
