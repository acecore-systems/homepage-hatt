export const CMS_REPOSITORY = {
  owner: 'acecore-systems',
  name: 'homepage-hatt',
  branch: 'main',
} as const

const CONTENT_RULES = [
  { prefix: 'src/content/art/', extension: '.json' },
  { prefix: 'src/content/authors/', extension: '.json' },
  { prefix: 'src/content/blog/', extension: '.md' },
  { prefix: 'src/content/campaigns/', extension: '.json' },
  { prefix: 'src/content/modeling/', extension: '.json' },
  { prefix: 'src/content/products/', extension: '.json' },
  { prefix: 'src/content/tags/', extension: '.json' },
] as const

const CONTENT_FILES = new Set([
  'src/content/shop-settings/main.json',
  'src/content/site/main.json',
])

const MEDIA_PREFIX = 'public/uploads/hatt/'
const MAX_CMS_PATH_LENGTH = 240
const MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.svg',
  '.webp',
])

const CMS_DIRECTORY_ROOTS = [
  ...CONTENT_RULES.map(({ prefix }) => prefix.slice(0, -1)),
  ...Array.from(CONTENT_FILES, (filePath) => getDirectoryName(filePath)),
  MEDIA_PREFIX.slice(0, -1),
]

export function normalizeCmsPath(path: string | null) {
  if (path === null || path.includes('\0')) return null

  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')

  if (normalized === '') return ''
  if (normalized.length > MAX_CMS_PATH_LENGTH) return null

  const segments = normalized.split('/')

  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null
  }

  return segments.join('/')
}

export function isAllowedCmsWritePath(path: string) {
  if (CONTENT_FILES.has(path)) return true

  if (
    CONTENT_RULES.some(({ prefix, extension }) => {
      return path.startsWith(prefix) && path.endsWith(extension)
    })
  ) {
    return true
  }

  if (!path.startsWith(MEDIA_PREFIX)) return false

  return MEDIA_EXTENSIONS.has(getExtension(path))
}

export function isAllowedCmsDirectoryPath(path: string) {
  if (path === '') return true

  return CMS_DIRECTORY_ROOTS.some((root) => {
    return (
      path === root ||
      path.startsWith(`${root}/`) ||
      root.startsWith(`${path}/`)
    )
  })
}

export function sanitizeCmsBranchPart(path: string) {
  const base = path
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return base || 'content'
}

export function encodePathSegments(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

function getDirectoryName(path: string) {
  return path.split('/').slice(0, -1).join('/')
}

function getExtension(path: string) {
  const fileName = path.split('/').pop() || ''
  const dot = fileName.lastIndexOf('.')

  return dot === -1 ? '' : fileName.slice(dot).toLowerCase()
}
