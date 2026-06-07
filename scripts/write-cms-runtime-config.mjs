import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const cmsBranch =
  process.env.CF_PAGES_BRANCH ||
  process.env.GITHUB_HEAD_REF ||
  process.env.GITHUB_REF_NAME ||
  process.env.BRANCH ||
  'main'

const outputPath = resolve('public/admin/runtime-config.js')

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(
  outputPath,
  `window.CMS_MANUAL_INIT = true;\nwindow.HATT_CMS_BRANCH = ${JSON.stringify(cmsBranch)};\n`,
  'utf8',
)

console.log(`CMS runtime config branch: ${cmsBranch}`)
