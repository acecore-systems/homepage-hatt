export function isExternalUrl(href: string) {
  return /^https?:\/\//.test(href)
}

export function withTrailingSlash(path: string) {
  return path.endsWith('/') ? path : `${path}/`
}

export function externalAttrs(href: string) {
  return isExternalUrl(href)
    ? {
        rel: 'noreferrer noopener',
        target: '_blank',
      }
    : {}
}
