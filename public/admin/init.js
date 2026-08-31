import { registerProductFileFieldType } from './product-files.js'

export async function initCms({
  cms = globalThis.window?.CMS,
  documentRef = globalThis.document,
  fetchImpl = globalThis.fetch,
  windowRef = globalThis.window,
} = {}) {
  const root = documentRef.getElementById('nc-root') || documentRef.body

  try {
    if (!cms?.init) {
      throw new Error('Sveltia CMSの読み込みに失敗しました。')
    }

    registerProductFileFieldType(cms, windowRef)

    const session = await fetchImpl('/admin/api/session', {
      credentials: 'include',
    })

    if (!session.ok) {
      const data = await session.json().catch(() => ({}))
      throw new Error(
        getErrorMessage(data) || 'Cloudflare Accessでログインしてください。',
      )
    }

    const user = await fetchImpl('/admin/api/github/user', {
      credentials: 'include',
    })

    if (!user.ok) {
      const data = await user.json().catch(() => ({}))
      throw new Error(
        getErrorMessage(data) ||
          'GitHub proxyの確認に失敗しました。GitHub AppのPages設定を確認してください。',
      )
    }

    if (
      !windowRef.location.hash ||
      windowRef.location.hash === '#' ||
      windowRef.location.hash === '#/'
    ) {
      const payload = windowRef.btoa(
        JSON.stringify({
          token: 'cloudflare-access',
          prefs: { language: 'ja' },
        }),
      )
      windowRef.history.replaceState(
        null,
        '',
        `${windowRef.location.pathname}${windowRef.location.search}#/signin/${payload}`,
      )
    }

    await cms.init()
    showPublishNotice(documentRef)
  } catch (error) {
    showStatus(
      root,
      error instanceof Error ? error.message : String(error),
      true,
    )
  }
}

function showPublishNotice(documentRef) {
  if (documentRef.getElementById('cms-publish-notice')) return

  const notice = documentRef.createElement('aside')
  const title = documentRef.createElement('strong')
  const body = documentRef.createElement('span')
  const close = documentRef.createElement('button')

  notice.id = 'cms-publish-notice'
  notice.className = 'cms-publish-notice'
  notice.setAttribute('aria-label', 'CMSの公開方法')
  title.textContent = '保存すると自動で公開されます'
  body.textContent = '保存後、Cloudflare Pagesに反映されます。'
  close.className = 'cms-publish-notice__close'
  close.type = 'button'
  close.setAttribute('aria-label', '公開方法の案内を閉じる')
  close.textContent = '×'
  close.addEventListener('click', () => notice.remove())
  notice.append(title, body, close)
  documentRef.body.append(notice)
}

function getErrorMessage(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.message === 'string') return data.message
  if (typeof data.error === 'string') return data.error

  return ''
}

function showStatus(root, message, isError = false) {
  root.innerHTML = `
    <section class="cms-status${isError ? ' cms-status--error' : ''}">
      <p>${escapeHtml(message)}</p>
    </section>
  `
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]
  })
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const root = document.getElementById('nc-root') || document.body
  showStatus(root, 'Sveltia CMSを読み込んでいます。')
  void initCms()
}
