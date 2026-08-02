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
  { prefix: 'src/content/tags/', extension: '.json' },
] as const

const CONTENT_FILES = new Set(['src/content/site/main.json'])
const DELETABLE_CONTENT_PREFIXES = new Set([
  'src/content/art/',
  'src/content/blog/',
  'src/content/campaigns/',
  'src/content/modeling/',
])

const MEDIA_PREFIX = 'public/uploads/hatt/'
const MAX_CMS_PATH_LENGTH = 240
const MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
])

const CONTENT_DIRECTORY_ROOTS = [
  ...CONTENT_RULES.map(({ prefix }) => prefix.slice(0, -1)),
  ...Array.from(CONTENT_FILES, (filePath) => getDirectoryName(filePath)),
]
const MEDIA_DIRECTORY_ROOT = MEDIA_PREFIX.slice(0, -1)

export function normalizeCmsPath(path: string | null) {
  if (path === null || /[\u0000-\u001f\u007f]/.test(path)) return null

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

  if (CONTENT_RULES.some((rule) => matchesDirectContentPath(path, rule))) {
    return true
  }

  if (!path.startsWith(MEDIA_PREFIX)) return false

  return MEDIA_EXTENSIONS.has(getExtension(path))
}

export function isAllowedCmsDeletePath(path: string) {
  return CONTENT_RULES.some(
    (rule) =>
      DELETABLE_CONTENT_PREFIXES.has(rule.prefix) &&
      matchesDirectContentPath(path, rule),
  )
}

export function isCmsReferenceTextPath(path: string) {
  if (normalizeCmsPath(path) !== path) return false
  if (CONTENT_FILES.has(path)) return true

  return CONTENT_RULES.some((rule) => matchesDirectContentPath(path, rule))
}

export function isCmsReferenceStatePath(path: string) {
  if (isCmsReferenceTextPath(path)) return true
  if (normalizeCmsPath(path) !== path || !path.startsWith(MEDIA_PREFIX)) {
    return false
  }

  return MEDIA_EXTENSIONS.has(getExtension(path))
}

export function isAllowedCmsDirectoryPath(path: string) {
  if (path === '') return true

  if (
    CONTENT_DIRECTORY_ROOTS.some(
      (root) => path === root || root.startsWith(`${path}/`),
    )
  ) {
    return true
  }

  return (
    path === MEDIA_DIRECTORY_ROOT ||
    path.startsWith(`${MEDIA_DIRECTORY_ROOT}/`) ||
    MEDIA_DIRECTORY_ROOT.startsWith(`${path}/`)
  )
}

export function encodePathSegments(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

function getDirectoryName(path: string) {
  return path.split('/').slice(0, -1).join('/')
}

function matchesDirectContentPath(
  path: string,
  {
    extension,
    prefix,
  }: {
    extension: string
    prefix: string
  },
) {
  if (!path.startsWith(prefix) || !path.endsWith(extension)) return false

  const fileName = path.slice(prefix.length)

  return fileName.length > extension.length && !fileName.includes('/')
}

function getExtension(path: string) {
  const fileName = path.split('/').pop() || ''
  const dot = fileName.lastIndexOf('.')

  return dot === -1 ? '' : fileName.slice(dot).toLowerCase()
}
