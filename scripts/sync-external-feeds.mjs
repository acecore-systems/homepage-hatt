import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { XMLParser } from 'fast-xml-parser'

const root = process.cwd()
const outDir = path.join(root, 'src', 'data', 'external')
const narouUserId = '2047731'
const narouAuthorUrl = `https://mypage.syosetu.com/${narouUserId}/`
const youtubeChannelId = 'UCzEhXHKDoOrvjFUcIe5q3jA'
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

async function syncNovels() {
  const apiUrl = new URL('https://api.syosetu.com/novelapi/api/')
  apiUrl.search = new URLSearchParams({
    out: 'json',
    userid: narouUserId,
    lim: '500',
    order: 'new',
  })

  const raw = await fetchText(apiUrl)
  const data = JSON.parse(raw)
  const [{ allcount = 0 } = {}, ...items] = data
  const works = items.map((item) => ({
    title: item.title,
    ncode: item.ncode,
    url: `https://ncode.syosetu.com/${String(item.ncode).toLowerCase()}/`,
    story: item.story,
    firstPublishedAt: formatNarouDate(item.general_firstup),
    lastUpdatedAt: formatNarouDate(item.general_lastup),
    totalParts: item.general_all_no,
    length: item.length,
    readingMinutes: item.time,
    isCompleted: item.end === 1,
    isStopped: item.isstop === 1,
    type: item.novel_type === 2 ? 'short' : 'serial',
  }))

  return {
    source: 'syosetu',
    schemaVersion: 1,
    userId: narouUserId,
    authorUrl: narouAuthorUrl,
    syncedAt: new Date().toISOString(),
    allcount,
    works,
  }
}

async function syncYoutubeVideos() {
  const raw = await fetchText(youtubeFeedUrl)
  const feed = youtubeXmlParser.parse(raw).feed ?? {}
  const entries = asArray(feed.entry)
  const videos = entries
    .map((entry) => {
      const videoId = entry['yt:videoId']
      const mediaGroup = entry['media:group'] ?? {}
      const title = entry.title ?? mediaGroup['media:title'] ?? ''
      const url =
        entry.link?.['@_href'] ?? `https://www.youtube.com/watch?v=${videoId}`
      const description = mediaGroup['media:description'] ?? ''

      return {
        videoId,
        title,
        url,
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
        thumbnailUrl:
          mediaGroup['media:thumbnail']?.['@_url'] ??
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        authorName: entry.author?.name ?? 'Hatt',
        authorUrl: entry.author?.uri ?? youtubeChannelUrl,
        publishedAt: entry.published ?? '',
        description,
      }
    })
    .filter((video) => video.videoId && video.title)
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
    syncedAt: new Date().toISOString(),
    videos,
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

async function main() {
  const [novels, youtubeVideos] = await Promise.all([
    syncNovels(),
    syncYoutubeVideos(),
  ])
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
