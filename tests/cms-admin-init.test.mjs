import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initCms } from '../public/admin/init.js'

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
  const registeredFieldTypes = []
  let cmsInitCount = 0

  const documentRef = {
    body,
    createElement,
    getElementById(id) {
      if (id === 'nc-root') return root

      return body.children.find((child) => child.id === id) ?? null
    },
  }
  const location = {
    hash,
    origin: 'https://cms.example.com',
    pathname: '/admin/',
    search: '?from=access',
  }
  const history = {
    replaceState(_state, _title, url) {
      replacedUrls.push(url)
      location.hash = url.slice(url.indexOf('#'))
    },
  }
  const cms = {
    async init() {
      cmsInitCount += 1
    },
    registerFieldType(name) {
      registeredFieldTypes.push(name)
    },
  }
  const windowRef = {
    AbortController,
    CMS: cms,
    addEventListener() {},
    btoa,
    createClass(definition) {
      return definition
    },
    fetch() {},
    h() {},
    history,
    location,
    removeEventListener() {},
  }

  await initCms({
    cms,
    documentRef,
    fetchImpl: async (url) => {
      requests.push(url)

      return {
        ok: true,
        async json() {
          return {}
        },
      }
    },
    windowRef,
  })

  return {
    body,
    cmsInitCount,
    location,
    registeredFieldTypes,
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
  assert.deepEqual(result.registeredFieldTypes, ['shop_product_file'])
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
