const SITE_ORIGIN = 'https://hatt.acecore.net'
const CLOUDFLARE_IMAGE_PREFIX = '/cdn-cgi/image/'

type OptimizeImageOptions = {
  width?: number | string
  height?: number | string
  quality?: number | string
}

type ParsedImageSource = {
  sourceUrl: string
  width?: string
  height?: string
  quality?: string
}

function shouldServeDirectly(url: string) {
  return (
    url.startsWith('/') &&
    !url.startsWith('//') &&
    !url.startsWith(CLOUDFLARE_IMAGE_PREFIX)
  )
}

function parseCloudflareImageUrl(url: string): ParsedImageSource | null {
  try {
    const parsed = new URL(url, SITE_ORIGIN)
    if (!parsed.pathname.startsWith(CLOUDFLARE_IMAGE_PREFIX)) return null

    const body = parsed.pathname.slice(CLOUDFLARE_IMAGE_PREFIX.length)
    const slashIndex = body.indexOf('/')
    if (slashIndex === -1) return null

    const options = new Map(
      body
        .slice(0, slashIndex)
        .split(',')
        .map((entry) => entry.split('='))
        .filter((entry): entry is [string, string] => entry.length === 2),
    )
    const sourceUrlText = body.slice(slashIndex + 1)
    const sourceUrl =
      sourceUrlText.startsWith('http://') ||
      sourceUrlText.startsWith('https://')
        ? sourceUrlText
        : `/${sourceUrlText.replace(/^\/+/, '')}`

    return {
      sourceUrl,
      width: options.get('width'),
      height: options.get('height'),
      quality: options.get('quality'),
    }
  } catch {
    return null
  }
}

function parseImageSource(url: string): ParsedImageSource | null {
  const cloudflareImage = parseCloudflareImageUrl(url)
  if (cloudflareImage) return cloudflareImage

  try {
    const parsed = new URL(url, SITE_ORIGIN)
    const isLocalOrigin = parsed.origin === SITE_ORIGIN

    return {
      sourceUrl: isLocalOrigin
        ? `${parsed.pathname}${parsed.search}`
        : parsed.toString(),
      width: parsed.searchParams.get('w') ?? undefined,
      height: parsed.searchParams.get('h') ?? undefined,
    }
  } catch {
    return null
  }
}

function buildCloudflareImageUrl(
  sourceUrl: string,
  dimensions: { width?: string; height?: string },
  quality = '60',
) {
  const { width, height } = dimensions
  const transformOptions: string[] = []

  if (width) transformOptions.push(`width=${width}`)
  if (height) transformOptions.push(`height=${height}`)

  transformOptions.push(`fit=${width && height ? 'cover' : 'scale-down'}`)
  transformOptions.push('format=auto', `quality=${quality}`, 'metadata=none')

  const separator = sourceUrl.startsWith('/') ? '' : '/'
  const transformOrigin = sourceUrl.startsWith('/') ? '' : SITE_ORIGIN

  return `${transformOrigin}${CLOUDFLARE_IMAGE_PREFIX}${transformOptions.join(',')}${separator}${sourceUrl}`
}

export function optimizeImage(
  url: string,
  overrides: OptimizeImageOptions = {},
) {
  if (shouldServeDirectly(url)) return url

  const parsed = parseImageSource(url)
  if (!parsed) return url

  return buildCloudflareImageUrl(
    parsed.sourceUrl,
    {
      width: overrides.width != null ? String(overrides.width) : parsed.width,
      height:
        overrides.height != null ? String(overrides.height) : parsed.height,
    },
    overrides.quality != null
      ? String(overrides.quality)
      : (parsed.quality ?? '60'),
  )
}
