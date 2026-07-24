import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const errors = []

function fail(scope, message) {
  errors.push(`${scope}: ${message}`)
}

async function fileExists(relativePath) {
  try {
    await access(path.join(root, relativePath))
    return true
  } catch {
    return false
  }
}

function extractCmsContentPaths(config) {
  const paths = []
  const pathPattern = /^\s*(?:folder|file):\s*['"]?([^'"\n#]+?)['"]?\s*$/gm
  for (const match of config.matchAll(pathPattern)) {
    paths.push(match[1].trim())
  }
  return paths
}

function isAllowedCmsContentPath(contentPath) {
  return (
    contentPath === 'src/content/blog' ||
    contentPath === 'src/content/art' ||
    contentPath === 'src/content/modeling' ||
    contentPath === 'src/content/products' ||
    contentPath === 'src/content/tags' ||
    contentPath === 'src/content/authors' ||
    contentPath === 'src/content/campaigns' ||
    contentPath === 'src/content/site/main.json' ||
    contentPath === 'src/content/shop-settings/main.json'
  )
}

async function validateCmsConfig() {
  const scope = 'public/admin/config.yml'
  const config = await readFile(path.join(root, scope), 'utf8')

  if (/^\s*-?\s*name:\s*path\b/m.test(config)) {
    fail(scope, 'path field must not be exposed in CMS')
  }
  if (!/backend:\s*[\s\S]*?\n\s+branch:\s*main\b/.test(config)) {
    fail(
      scope,
      'CMS backend branch must be main; do not use a permanent cms-content branch',
    )
  }
  if (
    !/backend:\s*[\s\S]*?\n\s+api_root:\s*\/admin\/api\/github\b/.test(config)
  ) {
    fail(scope, 'CMS backend must use the local GitHub proxy api_root')
  }
  if (
    !/backend:\s*[\s\S]*?\n\s+graphql_api_root:\s*\/admin\/api\/graphql\b/.test(
      config,
    )
  ) {
    fail(scope, 'CMS backend must use the local GraphQL proxy')
  }
  if (
    !/backend:\s*[\s\S]*?\n\s+auth_methods:\s*\n\s+-\s*token\b/.test(config)
  ) {
    fail(scope, 'CMS backend must use token auth through Cloudflare Access')
  }
  if (!/backend:\s*[\s\S]*?\n\s+include_credentials:\s*true\b/.test(config)) {
    fail(scope, 'CMS backend must include credentials for the Access proxy')
  }
  if (/^\s*base_url:\s*https?:\/\/sveltia-cms-auth\b/m.test(config)) {
    fail(scope, 'CMS must not use the legacy GitHub OAuth Worker')
  }
  if (/^\s*publish_mode:\s*editorial_workflow\b/m.test(config)) {
    fail(scope, 'CMS PR workflow is handled by the local Access proxy')
  }

  for (const contentPath of extractCmsContentPaths(config)) {
    if (!isAllowedCmsContentPath(contentPath)) {
      fail(scope, `unexpected CMS content path (${contentPath})`)
      continue
    }
    if (!(await fileExists(contentPath))) {
      fail(scope, `CMS content path does not exist (${contentPath})`)
    }
  }
}

await validateCmsConfig()

if (errors.length > 0) {
  console.error('Content validation failed:')
  for (const error of errors) {
    console.error(`- ${error}`)
  }
  process.exit(1)
}

console.log('Content validation passed.')
