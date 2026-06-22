const root = document.getElementById('nc-root') || document.body

showStatus('Sveltia CMSを読み込んでいます。')

async function initCms() {
  try {
    if (!window.CMS?.init) {
      throw new Error('Sveltia CMSの読み込みに失敗しました。')
    }

    const session = await fetch('/admin/api/session', {
      credentials: 'include',
    })

    if (!session.ok) {
      const data = await session.json().catch(() => ({}))
      throw new Error(
        getErrorMessage(data) || 'Cloudflare Accessでログインしてください。',
      )
    }

    const user = await fetch('/admin/api/github/user', {
      credentials: 'include',
    })

    if (!user.ok) {
      const data = await user.json().catch(() => ({}))
      throw new Error(
        getErrorMessage(data) ||
          'GitHub proxyの確認に失敗しました。CMS_GITHUB_TOKENを確認してください。',
      )
    }

    window.location.hash =
      '#access_token=cloudflare-access&token_type=bearer&provider=github'
    window.CMS.init()
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true)
  }
}

function getErrorMessage(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.message === 'string') return data.message
  if (typeof data.error === 'string') return data.error

  return ''
}

function showStatus(message, isError = false) {
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

initCms()
