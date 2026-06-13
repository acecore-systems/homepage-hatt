import fs from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'src', 'data', 'external')
const narouUserId = '2047731'
const narouAuthorUrl = `https://mypage.syosetu.com/${narouUserId}/`
const youtubeChannelId = 'UCzEhXHKDoOrvjFUcIe5q3jA'
const youtubeUploadsPlaylistId = `UU${youtubeChannelId.slice(2)}`
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

function addVideoRef(refs, seenIds, url, titleHint) {
  const videoId = getVideoId(url)
  if (!videoId || seenIds.has(videoId)) return

  seenIds.add(videoId)
  refs.push({ videoId, titleHint })
}

async function readModelingVideoRefs() {
  const dir = path.join(root, 'src', 'content', 'modeling')
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const refs = []
  const seenIds = new Set()

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue

    const content = await fs.readFile(path.join(dir, entry.name), 'utf8')
    const data = JSON.parse(content)

    addVideoRef(refs, seenIds, data.youtubeUrl, data.title)

    for (const link of data.related ?? []) {
      addVideoRef(refs, seenIds, link.href, link.label)
    }
  }

  return refs
}

async function fetchOEmbed({ videoId, titleHint }) {
  const url = new URL('https://www.youtube.com/oembed')
  url.search = new URLSearchParams({
    format: 'json',
    url: `https://www.youtube.com/watch?v=${videoId}`,
  })

  let data
  try {
    data = JSON.parse(await fetchText(url))
  } catch {
    data = {
      title: titleHint ?? `YouTube動画 ${videoId}`,
      author_name: 'Hatt',
      author_url: youtubeChannelUrl,
      thumbnail_url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    }
  }

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

async function syncYoutubeVideos() {
  const modelingVideoRefs = await readModelingVideoRefs()
  const modelingVideos = await Promise.all(modelingVideoRefs.map(fetchOEmbed))

  const videos = modelingVideos.sort((a, b) => {
    if (!a.publishedAt && !b.publishedAt) return a.title.localeCompare(b.title)
    if (!a.publishedAt) return 1
    if (!b.publishedAt) return -1
    return b.publishedAt.localeCompare(a.publishedAt)
  })

  return {
    source: 'modeling-oembed',
    channelId: youtubeChannelId,
    channelUrl: youtubeChannelUrl,
    uploadsPlaylistId: youtubeUploadsPlaylistId,
    uploadsPlaylistUrl: `https://www.youtube.com/playlist?list=${youtubeUploadsPlaylistId}`,
    uploadsEmbedUrl: `https://www.youtube-nocookie.com/embed/videoseries?list=${youtubeUploadsPlaylistId}`,
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
