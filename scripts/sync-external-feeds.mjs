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

async function syncYoutubeVideos() {
  return {
    source: 'youtube-uploads-playlist',
    channelId: youtubeChannelId,
    channelUrl: youtubeChannelUrl,
    uploadsPlaylistId: youtubeUploadsPlaylistId,
    uploadsPlaylistUrl: `https://www.youtube.com/playlist?list=${youtubeUploadsPlaylistId}`,
    uploadsEmbedUrl: `https://www.youtube-nocookie.com/embed/videoseries?list=${youtubeUploadsPlaylistId}`,
    syncedAt: new Date().toISOString(),
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
  `Synced ${novels.works.length} novels and YouTube uploads playlist metadata.`,
)
