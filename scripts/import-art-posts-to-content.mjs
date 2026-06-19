import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const artFeedPath = path.join(root, 'src', 'data', 'external', 'art-posts.json')
const excludedIdsPath = path.join(
  root,
  'src',
  'data',
  'external',
  'art-excluded-ids.json',
)
const outDir = path.join(root, 'src', 'content', 'art')

const [artFeed, excludedIds] = await Promise.all([
  fs.readFile(artFeedPath, 'utf8').then(JSON.parse),
  fs.readFile(excludedIdsPath, 'utf8').then(JSON.parse),
])
const excludedIdSet = new Set(excludedIds)

let created = 0
let skipped = 0
let excluded = 0

await fs.mkdir(outDir, { recursive: true })

for (const item of artFeed.items ?? []) {
  if (!item.id) {
    skipped += 1
    continue
  }
  if (excludedIdSet.has(item.id)) {
    excluded += 1
    continue
  }

  const filePath = path.join(outDir, `${item.id}.json`)
  const content = {
    sourceUrl: item.sourceUrl,
    image: item.image,
  }

  try {
    await fs.writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, {
      flag: 'wx',
    })
    created += 1
  } catch (error) {
    if (error?.code === 'EEXIST') {
      skipped += 1
      continue
    }

    throw error
  }
}

console.log(
  `Imported ${created} art posts, skipped ${skipped}, excluded ${excluded}.`,
)
