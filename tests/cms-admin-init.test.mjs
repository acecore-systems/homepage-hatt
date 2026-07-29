import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const initSource = await readFile(
  new URL('../public/admin/init.js', import.meta.url),
  'utf8',
)

function createElement(tagName) {
  return {
    tagName,
    attributes: {},
    children: [],
    className: '',
    id: '',
    innerHTML: '',
    listeners: {},
    textContent: '',
    type: '',
    addEventListener(type, listener) {
      this.listeners[type] = listener
    },
    append(...children) {
      this.children.push(...children)
    },
    remove() {
      this.removed = true
    },
    setAttribute(name, value) {
      this.attributes[name] = value
    },
  }
}

async function runAdminInit(hash = '') {
  const root = createElement('main')
  root.id = 'nc-root'
  const body = createElement('body')
  const requests = []
  const replacedUrls = []
  let cmsInitCount = 0

  const document = {
    body,
    createElement,
    getElementById(id) {
      if (id === 'nc-root') return root

      return body.children.find((child) => child.id === id) ?? null
    },
  }
  const location = {
    hash,
    pathname: '/admin/',
    search: '?from=access',
  }
  const history = {
    replaceState(_state, _title, url) {
      replacedUrls.push(url)
      location.hash = url.slice(url.indexOf('#'))
    },
  }
  const window = {
    CMS: {
      async init() {
        cmsInitCount += 1
      },
    },
    btoa,
    history,
    location,
  }

  runInNewContext(initSource, {
    document,
    fetch: async (url) => {
      requests.push(url)

      return {
        ok: true,
        async json() {
          return {}
        },
      }
    },
    window,
  })

  await new Promise(setImmediate)

  return {
    body,
    cmsInitCount,
    location,
    replacedUrls,
    requests,
  }
}

test('Cloudflare Access認証をSveltiaのsignin payloadへ渡して自動ログインする', async () => {
  const result = await runAdminInit()
  const payload = btoa(
    JSON.stringify({
      token: 'cloudflare-access',
      prefs: { language: 'ja' },
    }),
  )

  assert.deepEqual(result.requests, [
    '/admin/api/session',
    '/admin/api/github/user',
  ])
  assert.equal(result.cmsInitCount, 1)
  assert.deepEqual(result.replacedUrls, [
    `/admin/?from=access#/signin/${payload}`,
  ])
  assert.equal(result.location.hash, `#/signin/${payload}`)
  assert.doesNotMatch(result.location.hash, /access_token=/)

  const notice = result.body.children.find(
    (child) => child.id === 'cms-publish-notice',
  )
  assert.ok(notice)
  assert.deepEqual(
    notice.children.slice(0, 2).map((child) => child.textContent),
    [
      '保存すると自動で公開されます',
      '保存後、Cloudflare Pagesに反映されます。',
    ],
  )
})

test('Sveltia内の既存routeはsignin payloadで上書きしない', async () => {
  const result = await runAdminInit('#/collections/blog')

  assert.equal(result.cmsInitCount, 1)
  assert.deepEqual(result.replacedUrls, [])
  assert.equal(result.location.hash, '#/collections/blog')
})
