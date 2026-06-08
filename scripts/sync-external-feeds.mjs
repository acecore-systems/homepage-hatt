import fs from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'src', 'data', 'external')
const narouUserId = '2047731'
const narouAuthorUrl = `https://mypage.syosetu.com/${narouUserId}/`
const youtubeChannelId = 'UCRd3wlD5zemJ7Q9C1SZoEDw'
const youtubeChannelUrl = 'https://www.youtube.com/@hatt9241'

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

function decodeHtml(value = '') {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
}

function getVideoId(url = '') {
  const match = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,})/,
  )
  return match?.[1]
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
    updatedAt: formatNarouDate(item.updated_at),
    totalParts: item.general_all_no,
    length: item.length,
    readingMinutes: item.time,
    isCompleted: item.end === 1,
    isStopped: item.isstop === 1,
    type: item.novel_type === 2 ? 'short' : 'serial',
    globalPoint: item.global_point,
  }))

  return {
    source: 'syosetu',
    userId: narouUserId,
    authorUrl: narouAuthorUrl,
    syncedAt: new Date().toISOString(),
    allcount,
    works,
  }
}

async function readModelingVideoIds() {
  const dir = path.join(root, 'src', 'content', 'modeling')
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const ids = new Set()

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue

    const content = await fs.readFile(path.join(dir, entry.name), 'utf8')
    const data = JSON.parse(content)
    const videoId = getVideoId(data.youtubeUrl)

    if (videoId) ids.add(videoId)
  }

  return [...ids]
}

async function fetchOEmbed(videoId) {
  const url = new URL('https://www.youtube.com/oembed')
  url.search = new URLSearchParams({
    format: 'json',
    url: `https://www.youtube.com/watch?v=${videoId}`,
  })

  const data = JSON.parse(await fetchText(url))

  return {
    videoId,
    title: data.title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    authorName: data.author_name,
    authorUrl: data.author_url,
    thumbnailUrl: data.thumbnail_url,
    publishedAt: '',
    source: 'modeling',
  }
}

function parseYoutubeFeed(xml) {
  return [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map((match) => {
    const entry = match[0]
    const videoId = entry.match(/<yt:videoId>([^<]+)/)?.[1] ?? ''
    const title = decodeHtml(entry.match(/<title>([^<]+)/)?.[1] ?? '')
    const link =
      entry.match(/<link rel="alternate" href="([^"]+)/)?.[1] ??
      `https://www.youtube.com/watch?v=${videoId}`
    const thumbnailUrl =
      entry.match(/<media:thumbnail url="([^"]+)/)?.[1] ??
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`

    return {
      videoId,
      title,
      url: decodeHtml(link),
      authorName: decodeHtml(entry.match(/<name>([^<]+)/)?.[1] ?? 'Hatt'),
      authorUrl: youtubeChannelUrl,
      thumbnailUrl: decodeHtml(thumbnailUrl),
      publishedAt: entry.match(/<published>([^<]+)/)?.[1] ?? '',
      source: 'rss',
    }
  })
}

async function fetchYoutubeRssVideos() {
  const feedUrl = new URL('https://www.youtube.com/feeds/videos.xml')
  feedUrl.search = new URLSearchParams({ channel_id: youtubeChannelId })

  return parseYoutubeFeed(await fetchText(feedUrl))
}

async function fetchYoutubeApiVideos() {
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) return []

  const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels')
  channelUrl.search = new URLSearchParams({
    id: youtubeChannelId,
    key: apiKey,
    part: 'contentDetails',
  })
  const channelData = JSON.parse(await fetchText(channelUrl))
  const uploadsPlaylistId =
    channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads

  if (!uploadsPlaylistId) return []

  const videos = []
  let pageToken = ''

  do {
    const playlistUrl = new URL(
      'https://www.googleapis.com/youtube/v3/playlistItems',
    )
    playlistUrl.search = new URLSearchParams({
      key: apiKey,
      playlistId: uploadsPlaylistId,
      part: 'snippet,contentDetails',
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    })

    const data = JSON.parse(await fetchText(playlistUrl))
    for (const item of data.items ?? []) {
      const videoId = item.contentDetails?.videoId
      if (!videoId) continue

      videos.push({
        videoId,
        title: item.snippet?.title ?? '',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        authorName: item.snippet?.channelTitle ?? 'Hatt',
        authorUrl: youtubeChannelUrl,
        thumbnailUrl:
          item.snippet?.thumbnails?.high?.url ??
          item.snippet?.thumbnails?.medium?.url ??
          item.snippet?.thumbnails?.default?.url ??
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        publishedAt: item.contentDetails?.videoPublishedAt ?? '',
        source: 'youtube-api',
      })
    }

    pageToken = data.nextPageToken ?? ''
  } while (pageToken)

  return videos
}

async function syncYoutubeVideos() {
  const byId = new Map()
  const apiVideos = await fetchYoutubeApiVideos()
  const rssVideos = apiVideos.length ? [] : await fetchYoutubeRssVideos()
  const modelingVideoIds = await readModelingVideoIds()
  const modelingVideos = await Promise.all(modelingVideoIds.map(fetchOEmbed))

  for (const video of [...rssVideos, ...apiVideos, ...modelingVideos]) {
    if (!video.videoId) continue

    const previous = byId.get(video.videoId)
    byId.set(video.videoId, {
      ...previous,
      ...video,
      source: previous ? `${previous.source}+${video.source}` : video.source,
    })
  }

  const videos = [...byId.values()].sort((a, b) => {
    if (!a.publishedAt && !b.publishedAt) return a.title.localeCompare(b.title)
    if (!a.publishedAt) return 1
    if (!b.publishedAt) return -1
    return b.publishedAt.localeCompare(a.publishedAt)
  })

  return {
    source: apiVideos.length ? 'youtube-api' : 'youtube-rss+modeling-oembed',
    channelId: youtubeChannelId,
    channelUrl: youtubeChannelUrl,
    syncedAt: new Date().toISOString(),
    videos,
  }
}

async function writeJson(fileName, data) {
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(
    path.join(outDir, fileName),
    `${JSON.stringify(data, null, 2)}\n`,
  )
}

const [novels, youtubeVideos] = await Promise.all([
  syncNovels(),
  syncYoutubeVideos(),
])

await writeJson('novels.json', novels)
await writeJson('youtube-videos.json', youtubeVideos)

console.log(
  `Synced ${novels.works.length} novels and ${youtubeVideos.videos.length} YouTube videos.`,
)
