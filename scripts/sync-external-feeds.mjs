import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'homepage-hatt external feed sync',
    },
  })

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${url}`)
  }

  return response.text()
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
  const raw = await fetchText(youtubeFeedUrl)
  return parseYoutubeFeed(raw)
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

async function main() {
  const syncResults = await Promise.allSettled([
    syncNovels(),
    syncYoutubeVideos(),
  ])
  const failedSync = syncResults.find((result) => result.status === 'rejected')
  if (failedSync) throw failedSync.reason

  const [novels, youtubeVideos] = syncResults.map((result) => result.value)
  const syncedAt = new Date().toISOString()
  const [novelsChanged, youtubeVideosChanged] = await Promise.all([
    writeJsonIfChanged('novels.json', novels, { now: () => syncedAt }),
    writeJsonIfChanged('youtube-videos.json', youtubeVideos, {
      now: () => syncedAt,
    }),
  ])
  const changedFeeds = [
    novelsChanged && 'novels',
    youtubeVideosChanged && 'YouTube videos',
  ].filter(Boolean)

  if (changedFeeds.length === 0) {
    console.log(
      `External content is already current (${novels.works.length} novels and ${youtubeVideos.videos.length} YouTube videos).`,
    )
    return
  }

  console.log(
    `Updated ${changedFeeds.join(' and ')} (${novels.works.length} novels and ${youtubeVideos.videos.length} YouTube videos).`,
  )
}

const isEntryPoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isEntryPoint) {
  await main()
}
