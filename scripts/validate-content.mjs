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
    fail(scope, 'CMS publication is handled directly by the local Access proxy')
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

async function validateCmsProxyWiring() {
  const scope = 'CMS proxy wiring'
  const [graphql, githubApi, policy, references, contentValidator, schemas] =
    await Promise.all(
      [
        'functions/admin/api/graphql.ts',
        'functions/admin/api/_github-api.ts',
        'functions/admin/api/_cms-policy.ts',
        'functions/admin/api/_cms-reference-validator.ts',
        'functions/admin/api/_cms-content-validator.ts',
        'src/content-schemas.ts',
      ].map((relativePath) => readFile(path.join(root, relativePath), 'utf8')),
    )
  const checks = [
    {
      source: graphql,
      pattern: /fetchCmsReferenceState\(token,\s*mainSha\)/,
      message:
        'reference state must be fetched from the exact preflight main SHA',
    },
    {
      source: graphql,
      pattern: /validateProjectedCmsReferences\(\{/,
      message: 'projected reference validation must run before CMS commit',
    },
    {
      source: githubApi,
      pattern:
        /value\.isBinary !== false[\s\S]*value\.isTruncated !== false[\s\S]*value\.byteSize/,
      message:
        'reference blobs must fail closed on binary/truncated/size drift',
    },
    {
      source: policy,
      pattern:
        /CONTENT_RULES\.some\(\(rule\) => matchesDirectContentPath\(path, rule\)\)/,
      message: 'CMS collection writes must stay direct-child only',
    },
    {
      source: policy,
      pattern: /path\.startsWith\(`\$\{MEDIA_DIRECTORY_ROOT\}\/`\)/,
      message: 'nested directories must remain available for CMS media',
    },
    {
      source: references,
      pattern:
        /authorIds[\s\S]*tagIds[\s\S]*resolveLocalMediaPath[\s\S]*findMarkdownDestinations/,
      message:
        'projected state must validate author, tag, local media, and Markdown references',
    },
    {
      source: references,
      pattern:
        /registerUniqueRouteSlug\('tag'[\s\S]*registerUniqueRouteSlug\('blog'/,
      message: 'projected state must reject duplicate tag and blog route slugs',
    },
    {
      source: contentValidator,
      pattern: /MAX_CMS_TEXT_FILE_BYTES = 448 \* 1024/,
      message: 'CMS text must remain within the 448 KiB GraphQL read limit',
    },
    {
      source: contentValidator,
      pattern:
        /MAX_RASTER_BLOCKS[\s\S]*MAX_PNG_IDAT_CHUNKS[\s\S]*consumeRasterBlock/,
      message: 'raster parser block-count limits must remain wired',
    },
    {
      source: schemas,
      pattern:
        /contentRouteSlugSchema[\s\S]*tagRouteSlugSchema[\s\S]*value !== 'index'[\s\S]*slug: contentRouteSlugSchema\.optional\(\)[\s\S]*slug: tagRouteSlugSchema/,
      message: 'tag and blog slugs must share the safe route schema',
    },
    {
      source: schemas,
      pattern: /authorContentSchema[\s\S]*id: contentRouteSlugSchema/,
      message: 'author ids must use the shared safe route schema',
    },
  ]

  for (const check of checks) {
    if (!check.pattern.test(check.source)) {
      fail(scope, check.message)
    }
  }
}

await validateCmsConfig()
await validateCmsProxyWiring()

if (errors.length > 0) {
  console.error('Content validation failed:')
  for (const error of errors) {
    console.error(`- ${error}`)
  }
  process.exit(1)
}

console.log('Content validation passed.')
