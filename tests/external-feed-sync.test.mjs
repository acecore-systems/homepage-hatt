import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import {
  fetchText,
  syncExternalFeeds,
  parseBoothCollectionPage,
  parseBoothProductPage,
  parseNarouPayload,
  parseYoutubeFeed,
  syncBoothCatalog,
  writeJsonIfChanged,
} from '../scripts/sync-external-feeds.mjs'

const fixtureNow = () => '2026-08-17T00:00:00.000Z'

test('同期workflowは対象を選び、部分成功の公開後も取得失敗を報告する', async () => {
  const workflow = yaml.load(
    await fs.readFile(
      new URL(
        '../.github/workflows/sync-external-content.yml',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  const steps = workflow.jobs.sync.steps
  const external = steps.find((step) => step.id === 'external')
  const booth = steps.find((step) => step.id === 'booth')
  const report = steps.find((step) => step.name === 'Report feed failures')
  const evaluate = (expression, context) =>
    runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), context, {
      timeout: 1000,
    })
  for (const [eventName, schedule, expected] of [
    ['schedule', '23 */6 * * *', [true, false]],
    ['schedule', '47 3 * * *', [false, true]],
    ['workflow_dispatch', undefined, [true, true]],
  ]) {
    const context = { github: { event_name: eventName, event: { schedule } } }
    assert.deepEqual(
      [evaluate(external.if, context), evaluate(booth.if, context)],
      expected,
    )
  }
  assert.equal(external['continue-on-error'], true)
  assert.equal(booth['continue-on-error'], true)
  assert.ok(
    steps.indexOf(report) >
      steps.findIndex((step) => step.name === 'Merge the verified snapshot'),
  )
  for (const [externalOutcome, boothOutcome, expected] of [
    ['failure', 'skipped', true],
    ['success', 'failure', true],
    ['failure', 'success', true],
    ['failure', 'failure', true],
    ['success', 'skipped', false],
    ['skipped', 'success', false],
  ]) {
    assert.equal(
      evaluate(report.if, {
        cancelled: () => false,
        steps: {
          external: { outcome: externalOutcome },
          booth: { outcome: boothOutcome },
        },
      }),
      expected,
    )
  }
  assert.match(report.run, /exit 1/)
})

test('YouTubeの404・500・429から再試行で回復する', async () => {
  const statuses = [404, 500, 429, 200]
  const delays = []
  const result = await fetchText('https://example.test/feed', {
    retry404: true,
    fetchImpl: async () => new Response('feed', { status: statuses.shift() }),
    wait: async (delay) => delays.push(delay),
  })
  assert.equal(result, 'feed')
  assert.deepEqual(delays, [2000, 4000, 8000])
  assert.equal(statuses.length, 0)
})

test('恒久的なHTTPエラーは即時失敗し、継続する404も4回で打ち切る', async () => {
  for (const [status, retry404, expectedCalls] of [
    [403, true, 1],
    [404, false, 1],
    [404, true, 4],
  ]) {
    let calls = 0
    await assert.rejects(
      fetchText('https://example.test/feed', {
        retry404,
        fetchImpl: async () => {
          calls += 1
          return new Response('error', { status })
        },
        wait: async () => {},
      }),
      new RegExp(`Fetch failed: ${status}`),
    )
    assert.equal(calls, expectedCalls)
  }
})

test('ネットワーク切断と本文の中断も再試行する', async () => {
  let calls = 0
  const result = await fetchText('https://example.test/feed', {
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      if (calls === 2)
        return {
          ok: true,
          status: 200,
          text: async () => {
            throw new TypeError('terminated')
          },
        }
      return new Response('recovered')
    },
    wait: async () => {},
  })
  assert.equal(result, 'recovered')
  assert.equal(calls, 3)
})

test('本文が応答しない場合もタイムアウトし、次の試行は新しいsignalを使う', async () => {
  const signals = []
  // AbortSignal.timeout uses an unref timer; keep this simulated request alive.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    assert.equal(
      await fetchText('https://example.test/feed', {
        timeoutMs: 10,
        fetchImpl: async (_url, { signal }) => {
          signals.push(signal)
          if (signals.length > 1) return new Response('recovered')
          return {
            ok: true,
            status: 200,
            text: () =>
              new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                })
              }),
          }
        },
        wait: async () => {},
      }),
      'recovered',
    )
    assert.equal(signals[0].aborted, true)
    assert.notEqual(signals[0], signals[1])
  } finally {
    clearInterval(keepAlive)
  }
})

test('片方の取得失敗は旧データを維持し、もう片方の更新を保存して失敗を返す', async (t) => {
  const outputDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hatt-partial-sync-'),
  )
  t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }))
  for (const failed of ['novels', 'youtube']) {
    const previous = '{"previous":true}\n'
    await fs.writeFile(path.join(outputDirectory, 'novels.json'), previous)
    await fs.writeFile(
      path.join(outputDirectory, 'youtube-videos.json'),
      previous,
    )
    const fail = async () => {
      throw new Error('upstream unavailable')
    }
    await assert.rejects(
      syncExternalFeeds({
        outputDirectory,
        getNovels:
          failed === 'novels'
            ? fail
            : async () => ({ works: [{ title: 'new novel' }] }),
        getYoutube:
          failed === 'youtube'
            ? fail
            : async () => ({ videos: [{ title: 'new video' }] }),
      }),
      (error) => error instanceof AggregateError && error.errors.length === 1,
    )
    const failedFile =
      failed === 'novels' ? 'novels.json' : 'youtube-videos.json'
    const successFile =
      failed === 'novels' ? 'youtube-videos.json' : 'novels.json'
    assert.equal(
      await fs.readFile(path.join(outputDirectory, failedFile), 'utf8'),
      previous,
    )
    assert.match(
      await fs.readFile(path.join(outputDirectory, successFile), 'utf8'),
      /new (novel|video)/,
    )
  }
})

test('両方の取得失敗をまとめて報告し、ファイルを作らない', async (t) => {
  const outputDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hatt-failed-sync-'),
  )
  t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }))
  const fail = async () => {
    throw new Error('upstream unavailable')
  }
  await assert.rejects(
    syncExternalFeeds({ outputDirectory, getNovels: fail, getYoutube: fail }),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  )
  assert.deepEqual(await fs.readdir(outputDirectory), [])
})

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

test('絵のスナップショットは最新の返信ツリーまで含み、同じ画像を重複させない', async () => {
  const artFeed = JSON.parse(
    await fs.readFile(
      new URL('../src/data/external/art-posts.json', import.meta.url),
      'utf8',
    ),
  )

  assert.ok(artFeed.items.length >= 590)
  assert.ok(artFeed.items.some((item) => item.id === 'x-2083839529904124029-1'))
  assert.ok(artFeed.items.some((item) => item.id === 'x-2070436477117530128-1'))
  assert.equal(
    new Set(artFeed.items.map((item) => item.image)).size,
    artFeed.items.length,
  )
})

test('BOOTH公開カタログはアバター10件・ギミック4件を含む', async () => {
  const catalog = JSON.parse(
    await fs.readFile(
      new URL('../src/data/external/booth-products.json', import.meta.url),
      'utf8',
    ),
  )
  const productIds = catalog.products.map((product) => product.id)

  assert.equal(catalog.products.length, 14)
  assert.equal(new Set(productIds).size, catalog.products.length)
  assert.equal(
    catalog.products.filter((product) => product.category === 'アバター')
      .length,
    10,
  )
  assert.equal(
    catalog.products.filter((product) => product.category === 'ギミック')
      .length,
    4,
  )
  assert.ok(productIds.includes('8631449'))
  assert.ok(productIds.includes('6073427'))
  assert.ok(
    catalog.products.every(
      (product) =>
        Array.isArray(product.images) &&
        product.images.length > 0 &&
        product.images[0] === product.image &&
        new Set(product.images).size === product.images.length,
    ),
  )
})

test('BOOTH公開リストと商品JSON-LDから代表画像・ギャラリー画像を取得する', () => {
  const collection = `
    <a href="https://vetumheberehama.booth.pm/items/100">作品A</a>
    <a href="/items/101">作品B</a>
    <a href="https://vetumheberehama.booth.pm/items/100">重複作品A</a>
  `
  const listings = parseBoothCollectionPage(collection, {
    category: 'アバター',
    collectionUrl: 'https://vetumheberehama.booth.pm/item_lists/test',
  })

  assert.deepEqual(listings, [
    {
      id: '100',
      category: 'アバター',
      url: 'https://vetumheberehama.booth.pm/items/100',
    },
    {
      id: '101',
      category: 'アバター',
      url: 'https://vetumheberehama.booth.pm/items/101',
    },
  ])

  const productPage = `
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "テスト作品",
        "image": "https://booth.pximg.net/c/620x620/shop/i/100/11111111-1111-4111-8111-111111111111_base_resized.jpg",
        "offers": {
          "@type": "AggregateOffer",
          "lowPrice": "500",
          "highPrice": "900",
          "availability": "https://schema.org/InStock"
        }
      }
    </script>
    <img src="https://booth.pximg.net/c/620x620/shop/i/100/11111111-1111-4111-8111-111111111111.png" />
    <img src="https://booth.pximg.net/c/620x620/shop/i/100/22222222-2222-4222-8222-222222222222_base_resized.jpg" />
    <img src="https://booth.pximg.net/c/620x620/shop/i/100/22222222-2222-4222-8222-222222222222.png" />
    <img src="https://booth.pximg.net/c/620x620/shop/i/999/33333333-3333-4333-8333-333333333333_base_resized.jpg" />
  `
  const product = parseBoothProductPage(productPage, listings[0])

  assert.equal(product.title, 'テスト作品')
  assert.equal(product.price, 500)
  assert.equal(product.priceLabel, '¥500〜')
  assert.equal(product.availability, 'in_stock')
  assert.deepEqual(product.images, [
    'https://booth.pximg.net/c/620x620/shop/i/100/11111111-1111-4111-8111-111111111111_base_resized.jpg',
    'https://booth.pximg.net/c/620x620/shop/i/100/22222222-2222-4222-8222-222222222222_base_resized.jpg',
  ])
  assert.equal(product.image, product.images[0])
})

test('BOOTH同期は両方の公開リストと全商品ページが揃わなければ失敗する', async () => {
  const collectionUrl = {
    avatar: 'https://vetumheberehama.booth.pm/item_lists/r1LT6q2w',
    gimmick: 'https://vetumheberehama.booth.pm/item_lists/nZ6TXKVK',
  }
  const productPage = (id, title) => `
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "${title}",
        "image": "https://booth.pximg.net/c/620x620/shop/i/${id}/11111111-1111-4111-8111-111111111111_base_resized.jpg",
        "offers": { "price": "0", "availability": "https://schema.org/InStock" }
      }
    </script>
  `
  const fixture = new Map([
    [collectionUrl.avatar, '<a href="/items/100">作品A</a>'],
    [collectionUrl.gimmick, '<a href="/items/200">作品B</a>'],
    ['https://vetumheberehama.booth.pm/items/100', productPage('100', '作品A')],
    ['https://vetumheberehama.booth.pm/items/200', productPage('200', '作品B')],
  ])
  const getText = async (url) => {
    const text = fixture.get(String(url))
    if (!text) throw new Error(`Unexpected fixture URL: ${url}`)
    return text
  }

  const catalog = await syncBoothCatalog({ getText, now: fixtureNow })
  assert.equal(catalog.syncedAt, fixtureNow())
  assert.equal(catalog.products.length, 2)
  assert.equal(catalog.products[0].images.length, 1)

  await assert.rejects(
    () =>
      syncBoothCatalog({
        getText: async (url) =>
          url === collectionUrl.gimmick ? '<main>empty</main>' : getText(url),
      }),
    /ギミック collection returned no published products/,
  )
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
