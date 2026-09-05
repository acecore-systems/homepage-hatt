import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { XMLParser } from 'fast-xml-parser'

const root = process.cwd()
const outDir = path.join(root, 'src', 'data', 'external')
const narouUserId = '2047731'
const narouPageSize = 500
const narouAuthorUrl = `https://mypage.syosetu.com/${narouUserId}/`
const youtubeChannelId = 'UCzEhXHKDoOrvjFUcIe5q3jA'
const youtubeFeedChannelIds = new Set([
  youtubeChannelId,
  youtubeChannelId.slice(2),
])
const youtubeUploadsPlaylistId = `UU${youtubeChannelId.slice(2)}`
const youtubeChannelUrl = 'https://www.youtube.com/@hatt9241'
const youtubeFeedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${youtubeChannelId}`
const youtubeXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
})
const boothShopUrl = 'https://vetumheberehama.booth.pm/'
const boothCollections = [
  {
    category: 'アバター',
    url: 'https://vetumheberehama.booth.pm/item_lists/r1LT6q2w',
  },
  {
    category: 'ギミック',
    url: 'https://vetumheberehama.booth.pm/item_lists/nZ6TXKVK',
  },
]
const boothImageHost = 'booth.pximg.net'
const boothFetchConcurrency = 3

// These values change independently of the site's actual catalog content and
// should not trigger a commit or a Cloudflare Pages build on their own.
const volatileComparisonKeys = new Set([
  'globalPoint',
  'syncedAt',
  'updatedAt',
  'views',
])

function asArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

export async function fetchText(
  url,
  {
    fetchImpl = fetch,
    wait = sleep,
    timeoutMs = 15_000,
    retry404 = false,
  } = {},
) {
  const attempts = 4
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let status
    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': 'homepage-hatt external feed sync' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = response.status
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Fetch failed: ${status} ${url}`)
      }
      // Await the body here so stalled/interrupted downloads are retried too.
      return await response.text()
    } catch (error) {
      const retryable =
        status === undefined ||
        status === 200 ||
        status === 408 ||
        status === 429 ||
        status >= 500 ||
        (retry404 && status === 404)
      if (!retryable || attempt === attempts) throw error
      const delay = 2_000 * 2 ** (attempt - 1)
      console.warn(
        `Retry ${attempt}/${attempts - 1} in ${delay}ms: ${url}: ${error.message}`,
      )
      await wait(delay)
    }
  }
}

function formatNarouDate(value) {
  return value ? value.replace(' ', 'T') : ''
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is missing from the external feed.`)
  }

  return value
}

function requireNonNegativeNumber(value, label) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} is missing from the external feed.`)
  }

  return number
}

function formatYen(value) {
  return `¥${new Intl.NumberFormat('ja-JP').format(value)}`
}

function normalizeAvailability(value) {
  const state = String(value ?? '')
    .split('/')
    .pop()
    ?.toLowerCase()

  if (state === 'instock') return 'in_stock'
  if (state === 'outofstock') return 'out_of_stock'
  if (state === 'preorder') return 'preorder'
  return 'unknown'
}

function jsonLdEntries(value) {
  if (Array.isArray(value)) return value.flatMap(jsonLdEntries)
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value['@graph']))
    return value['@graph'].flatMap(jsonLdEntries)
  return [value]
}

function schemaIncludesProduct(value) {
  const types = asArray(value?.['@type'])
  return types.some((type) => type === 'Product')
}

function parseProductJsonLd(raw) {
  const blocks = raw.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )

  for (const block of blocks) {
    try {
      const products = jsonLdEntries(JSON.parse(block[1])).filter(
        schemaIncludesProduct,
      )
      if (products.length > 0) return products[0]
    } catch {
      // Ignore unrelated or malformed structured-data blocks and keep looking
      // for the product metadata published on the page.
    }
  }

  throw new Error('BOOTH product metadata is missing from the public page.')
}

function decodeHtmlUrl(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&#x2F;', '/')
    .replaceAll('&#47;', '/')
    .replaceAll('\\/', '/')
}

function boothImageCandidate(value, productId) {
  if (typeof value !== 'string') return undefined

  try {
    const url = new URL(decodeHtmlUrl(value))
    if (url.protocol !== 'https:' || url.hostname !== boothImageHost) {
      return undefined
    }

    const match = url.pathname.match(
      new RegExp(
        `/i/${productId}/([0-9a-f-]+)(?:_base_resized)?\\.(?:jpe?g|png|webp)$`,
        'i',
      ),
    )
    if (!match) return undefined

    const dimensions = url.pathname.match(/\/c\/(\d+)x(\d+)\//)
    return {
      key: match[1].toLowerCase(),
      url: url.toString(),
      isDisplayImage: /_base_resized\.(?:jpe?g|png|webp)$/i.test(url.pathname),
      area: dimensions ? Number(dimensions[1]) * Number(dimensions[2]) : 0,
    }
  } catch {
    return undefined
  }
}

function preferBoothImage(current, candidate) {
  if (!current) return candidate
  if (current.isDisplayImage !== candidate.isDisplayImage) {
    return candidate.isDisplayImage ? candidate : current
  }
  if (current.area !== candidate.area) {
    return candidate.area > current.area ? candidate : current
  }
  return candidate.url.localeCompare(current.url) < 0 ? candidate : current
}

export function extractBoothGalleryImages(raw, { productId, primaryImage }) {
  const primary = boothImageCandidate(primaryImage, productId)
  if (!primary) {
    throw new Error('BOOTH product primary image is missing or invalid.')
  }

  const candidates = new Map([[primary.key, primary]])
  const imageUrls =
    raw.match(/https:\/\/booth\.pximg\.net\/[^"'<>\\\s]+/g) ?? []

  for (const imageUrl of imageUrls) {
    const candidate = boothImageCandidate(imageUrl, productId)
    if (!candidate) continue
    candidates.set(
      candidate.key,
      preferBoothImage(candidates.get(candidate.key), candidate),
    )
  }

  const images = [...candidates.values()].map((candidate) => candidate.url)
  const primaryIndex = images.indexOf(candidates.get(primary.key).url)
  if (primaryIndex > 0) {
    images.unshift(images.splice(primaryIndex, 1)[0])
  }

  return images
}

export function parseBoothCollectionPage(raw, { category, collectionUrl }) {
  const sourceUrl = new URL(requireText(collectionUrl, 'BOOTH collection URL'))
  const normalizedCategory = requireText(category, 'BOOTH collection category')
  const productIds = []
  const seenIds = new Set()

  for (const match of raw.matchAll(
    /(?:https?:\/\/[^"'<>\s]+)?\/items\/(\d+)(?=["'/?#\s<]|$)/gi,
  )) {
    const id = match[1]
    if (seenIds.has(id)) continue
    seenIds.add(id)
    productIds.push(id)
  }

  if (productIds.length === 0) {
    throw new Error(
      `BOOTH ${normalizedCategory} collection returned no published products.`,
    )
  }

  return productIds.map((id) => ({
    id,
    category: normalizedCategory,
    url: new URL(`/items/${id}`, sourceUrl).toString(),
  }))
}

export function parseBoothProductPage(raw, { id, category, url }) {
  const product = parseProductJsonLd(raw)
  const offer = asArray(product.offers)[0]
  if (!offer || typeof offer !== 'object') {
    throw new Error(
      'BOOTH product offer metadata is missing from the public page.',
    )
  }

  const price = requireNonNegativeNumber(
    offer.lowPrice ?? offer.price,
    'BOOTH product price',
  )
  const highPrice = Number(offer.highPrice)
  const primaryImage = requireText(
    asArray(product.image)[0],
    'BOOTH product primary image',
  )
  const images = extractBoothGalleryImages(raw, {
    productId: id,
    primaryImage,
  })

  return {
    id,
    title: requireText(product.name, 'BOOTH product title'),
    category,
    price,
    priceLabel:
      Number.isFinite(highPrice) && highPrice > price
        ? `${formatYen(price)}〜`
        : formatYen(price),
    url,
    image: images[0],
    images,
    availability: normalizeAvailability(offer.availability),
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  )
  return results
}

export function parseNarouPayload(
  raw,
  { now = () => new Date().toISOString() } = {},
) {
  let data

  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new Error('Syosetu API returned invalid JSON.', { cause: error })
  }

  if (!Array.isArray(data)) {
    throw new Error('Syosetu API returned an unexpected response shape.')
  }

  const [summary, ...items] = data
  const allcount = Number(summary?.allcount)

  if (!Number.isSafeInteger(allcount) || allcount < 1) {
    throw new Error(
      'Syosetu API returned no published works; keeping the current snapshot.',
    )
  }

  const expectedCount = Math.min(allcount, narouPageSize)
  if (items.length !== expectedCount) {
    throw new Error(
      `Syosetu API returned ${items.length} of ${expectedCount} expected works; keeping the current snapshot.`,
    )
  }

  const works = items.map((item, index) => {
    const title = requireText(item?.title, `Syosetu work ${index + 1} title`)
    const ncode = requireText(item?.ncode, `Syosetu work ${index + 1} ncode`)

    return {
      title,
      ncode,
      url: `https://ncode.syosetu.com/${ncode.toLowerCase()}/`,
      story: item.story,
      firstPublishedAt: formatNarouDate(item.general_firstup),
      lastUpdatedAt: formatNarouDate(item.general_lastup),
      totalParts: item.general_all_no,
      length: item.length,
      readingMinutes: item.time,
      isCompleted: item.end === 1,
      isStopped: item.isstop === 1,
      type: item.novel_type === 2 ? 'short' : 'serial',
    }
  })

  return {
    source: 'syosetu',
    schemaVersion: 1,
    userId: narouUserId,
    authorUrl: narouAuthorUrl,
    syncedAt: now(),
    allcount,
    works,
  }
}

export function parseYoutubeFeed(
  raw,
  { now = () => new Date().toISOString() } = {},
) {
  const feed = youtubeXmlParser.parse(raw)?.feed

  if (!feed || typeof feed !== 'object') {
    throw new Error('YouTube RSS returned an unexpected response shape.')
  }

  if (!youtubeFeedChannelIds.has(feed['yt:channelId'])) {
    throw new Error('YouTube RSS returned a different channel.')
  }

  const entries = asArray(feed.entry)
  if (entries.length === 0) {
    throw new Error(
      'YouTube RSS returned no videos; keeping the current snapshot.',
    )
  }

  const videos = entries
    .map((entry, index) => {
      const videoId = requireText(
        entry?.['yt:videoId'],
        `YouTube entry ${index + 1} videoId`,
      )
      const mediaGroup = entry?.['media:group'] ?? {}
      const title = requireText(
        entry?.title ?? mediaGroup['media:title'],
        `YouTube entry ${index + 1} title`,
      )
      const publishedAt = requireText(
        entry?.published,
        `YouTube entry ${index + 1} publishedAt`,
      )
      const url =
        entry?.link?.['@_href'] ?? `https://www.youtube.com/watch?v=${videoId}`
      const description = mediaGroup['media:description'] ?? ''

      return {
        videoId,
        title,
        url,
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
        thumbnailUrl:
          mediaGroup['media:thumbnail']?.['@_url'] ??
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        authorName: entry?.author?.name ?? 'Hatt',
        authorUrl: entry?.author?.uri ?? youtubeChannelUrl,
        publishedAt,
        description,
      }
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))

  return {
    source: 'youtube-rss',
    schemaVersion: 1,
    channelId: youtubeChannelId,
    channelUrl: youtubeChannelUrl,
    feedUrl: youtubeFeedUrl,
    uploadsPlaylistId: youtubeUploadsPlaylistId,
    uploadsPlaylistUrl: `https://www.youtube.com/playlist?list=${youtubeUploadsPlaylistId}`,
    uploadsEmbedUrl: `https://www.youtube-nocookie.com/embed/videoseries?list=${youtubeUploadsPlaylistId}`,
    syncedAt: now(),
    videos,
  }
}

async function syncNovels() {
  const apiUrl = new URL('https://api.syosetu.com/novelapi/api/')
  apiUrl.search = new URLSearchParams({
    out: 'json',
    userid: narouUserId,
    lim: String(narouPageSize),
    order: 'new',
  })

  const raw = await fetchText(apiUrl)
  return parseNarouPayload(raw)
}

async function syncYoutubeVideos() {
  // This channel intermittently returns 404 even while the feed exists.
  const raw = await fetchText(youtubeFeedUrl, { retry404: true })
  return parseYoutubeFeed(raw)
}

export async function syncBoothCatalog({
  getText = fetchText,
  now = () => new Date().toISOString(),
} = {}) {
  const listings = (
    await Promise.all(
      boothCollections.map(async (collection) =>
        parseBoothCollectionPage(await getText(collection.url), {
          ...collection,
          collectionUrl: collection.url,
        }),
      ),
    )
  ).flat()

  if (new Set(listings.map((product) => product.id)).size !== listings.length) {
    throw new Error('BOOTH collections contain duplicate product IDs.')
  }

  const products = await mapWithConcurrency(
    listings,
    boothFetchConcurrency,
    async (listing) =>
      parseBoothProductPage(await getText(listing.url), listing),
  )

  if (
    products.length === 0 ||
    products.some((product) => product.images.length === 0)
  ) {
    throw new Error(
      'BOOTH catalog is incomplete; keeping the current snapshot.',
    )
  }

  return {
    source: 'booth-public-html+jsonld',
    schemaVersion: 2,
    shopUrl: boothShopUrl,
    collectionUrls: Object.fromEntries(
      boothCollections.map((collection) => [
        collection.category,
        collection.url,
      ]),
    ),
    syncedAt: now(),
    products,
  }
}

function comparableContent(value) {
  if (Array.isArray(value)) {
    return value.map(comparableContent)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !volatileComparisonKeys.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, comparableContent(item)]),
    )
  }

  return value
}

export function hasMeaningfulChanges(current, next) {
  return (
    JSON.stringify(comparableContent(current)) !==
    JSON.stringify(comparableContent(next))
  )
}

export async function writeJsonIfChanged(
  fileName,
  data,
  { outputDirectory = outDir, now = () => new Date().toISOString() } = {},
) {
  const filePath = path.join(outputDirectory, fileName)
  let current

  try {
    current = JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  if (current && !hasMeaningfulChanges(current, data)) {
    return false
  }

  await fs.mkdir(outputDirectory, { recursive: true })
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ ...data, syncedAt: now() }, null, 2)}\n`,
  )

  return true
}

export async function syncExternalFeeds({
  getNovels = syncNovels,
  getYoutube = syncYoutubeVideos,
  outputDirectory = outDir,
} = {}) {
  const feeds = [
    { name: 'novels', file: 'novels.json', get: getNovels, key: 'works' },
    {
      name: 'YouTube',
      file: 'youtube-videos.json',
      get: getYoutube,
      key: 'videos',
    },
  ]
  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      const data = await feed.get()
      const changed = await writeJsonIfChanged(feed.file, data, {
        outputDirectory,
      })
      console.log(
        `${feed.name}: ${changed ? 'updated' : 'already current'} (${data[feed.key].length} items).`,
      )
    }),
  )
  const errors = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return []
    const message = `${feeds[index].name} sync failed: ${result.reason.message}`
    console.error(message)
    return [new Error(message, { cause: result.reason })]
  })
  if (errors.length)
    throw new AggregateError(
      errors,
      'Some external feeds failed; successful feeds were saved.',
    )
}

async function syncBoothFeed() {
  const boothCatalog = await syncBoothCatalog()
  const changed = await writeJsonIfChanged('booth-products.json', boothCatalog)
  const imageCount = boothCatalog.products.reduce(
    (count, product) => count + product.images.length,
    0,
  )

  if (!changed) {
    console.log(
      `BOOTH catalog is already current (${boothCatalog.products.length} products and ${imageCount} images).`,
    )
    return
  }

  console.log(
    `Updated BOOTH catalog (${boothCatalog.products.length} products and ${imageCount} images).`,
  )
}

const isEntryPoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isEntryPoint) {
  if (process.argv.includes('--booth')) {
    await syncBoothFeed()
  } else {
    await syncExternalFeeds()
  }
}
