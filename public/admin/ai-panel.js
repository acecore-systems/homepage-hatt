;(function initCmsAiPanel() {
  const jobsEndpoint = '/admin/api/ai/jobs'
  const savedJobKey = 'hatt-cms-ai-job-id'
  const launcher = document.createElement('button')
  launcher.className = 'cms-ai-launcher'
  launcher.type = 'button'
  launcher.setAttribute('aria-controls', 'cms-ai-panel')
  launcher.setAttribute('aria-expanded', 'false')
  launcher.innerHTML =
    '<span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>AIに依頼'

  const panel = document.createElement('aside')
  panel.className = 'cms-ai-panel'
  panel.hidden = true
  panel.id = 'cms-ai-panel'
  panel.setAttribute('aria-label', 'AIに修正を依頼')
  panel.innerHTML = [
    '<header class="cms-ai-panel__header">',
    '  <div>',
    '    <h2 class="cms-ai-panel__title">AIに依頼</h2>',
    '    <p class="cms-ai-panel__description">Hattのページ修正を依頼すると、AIがPRと検証を行います。</p>',
    '  </div>',
    '  <button class="cms-ai-panel__close" type="button" aria-label="AI依頼パネルを閉じる">×</button>',
    '</header>',
    '<div class="cms-ai-panel__body">',
    '  <form class="cms-ai-form">',
    '    <label>対象URL',
    '      <input name="targetUrl" type="url" required />',
    '    </label>',
    '    <label>依頼内容',
    '      <textarea name="instruction" required maxlength="4000" placeholder="例: このページの見出しの余白を少し狭くして、スマホでも読みやすくして"></textarea>',
    '    </label>',
    '    <label>参考画像（任意）',
    '      <input name="referenceImage" type="file" accept="image/png,image/jpeg,image/webp" />',
    '    </label>',
    '    <p class="cms-ai-form__hint">PNG / JPEG / WebP、2 MiBまで。画像を生成せず、参考としてのみAIに渡します。</p>',
    '    <button class="cms-ai-form__submit" type="submit">依頼して自動検証へ</button>',
    '  </form>',
    '  <section class="cms-ai-job" hidden aria-live="polite">',
    '    <p class="cms-ai-job__state"></p>',
    '    <p class="cms-ai-job__detail"></p>',
    '    <ul class="cms-ai-job__paths"></ul>',
    '    <a class="cms-ai-job__link" hidden target="_blank" rel="noreferrer">Pull Requestを開く</a>',
    '  </section>',
    '</div>',
  ].join('')

  document.body.append(launcher, panel)

  const form = panel.querySelector('.cms-ai-form')
  const close = panel.querySelector('.cms-ai-panel__close')
  const submit = panel.querySelector('.cms-ai-form__submit')
  const jobView = panel.querySelector('.cms-ai-job')
  const state = panel.querySelector('.cms-ai-job__state')
  const detail = panel.querySelector('.cms-ai-job__detail')
  const paths = panel.querySelector('.cms-ai-job__paths')
  const prLink = panel.querySelector('.cms-ai-job__link')
  const target = form.elements.targetUrl
  let timer = 0

  target.value = window.location.origin + '/'

  launcher.addEventListener('click', () => {
    panel.hidden = false
    launcher.setAttribute('aria-expanded', 'true')
    target.focus()
  })
  close.addEventListener('click', () => {
    panel.hidden = true
    launcher.setAttribute('aria-expanded', 'false')
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    clearTimer()
    submit.disabled = true
    renderMessage('依頼を受け付けています。', '')

    try {
      const response = await fetch(jobsEndpoint, {
        body: new FormData(form),
        credentials: 'include',
        method: 'POST',
      })
      const payload = await response.json().catch(() => ({}))

      if (!response.ok || !payload.job) {
        throw new Error(
          readMessage(payload) || 'AI依頼を開始できませんでした。',
        )
      }

      rememberJob(payload.job.id)
      renderJob(payload.job)
      pollJob(payload.job.id)
    } catch (error) {
      renderMessage(
        '',
        error instanceof Error
          ? error.message
          : 'AI依頼を開始できませんでした。',
      )
    } finally {
      submit.disabled = false
    }
  })

  const savedJobId = readSavedJob()
  if (savedJobId) pollJob(savedJobId)

  function pollJob(jobId) {
    clearTimer()
    loadJob(jobId)
    timer = window.setInterval(() => loadJob(jobId), 3000)
  }

  async function loadJob(jobId) {
    try {
      const response = await fetch(
        jobsEndpoint + '/' + encodeURIComponent(jobId),
        {
          credentials: 'include',
        },
      )
      const payload = await response.json().catch(() => ({}))

      if (!response.ok || !payload.job) {
        clearTimer()
        forgetJob()
        return
      }

      renderJob(payload.job)

      if (!isPending(payload.job.status)) {
        clearTimer()
      }
    } catch {
      // 一時的な通信失敗は次のpollで回復させる。
    }
  }

  function renderJob(job) {
    jobView.hidden = false
    state.textContent = statusLabel(job.status)
    const description =
      job.clarification ||
      job.errorMessage ||
      job.summary ||
      'GitHub Actionsを起動しています。'
    detail.textContent = description
    paths.replaceChildren()

    for (const path of Array.isArray(job.changedPaths)
      ? job.changedPaths
      : []) {
      const item = document.createElement('li')
      item.textContent = path
      paths.append(item)
    }

    if (typeof job.prUrl === 'string' && job.prUrl) {
      prLink.href = job.prUrl
      prLink.hidden = false
    } else {
      prLink.hidden = true
      prLink.removeAttribute('href')
    }
  }

  function renderMessage(message, error) {
    jobView.hidden = false
    state.textContent = error ? '依頼を開始できませんでした' : message
    detail.textContent = error
    paths.replaceChildren()
    prLink.hidden = true
  }

  function clearTimer() {
    if (timer) {
      window.clearInterval(timer)
      timer = 0
    }
  }

  function isPending(status) {
    return (
      status === 'queued' || status === 'running' || status === 'validating'
    )
  }

  function statusLabel(status) {
    return (
      {
        queued: 'GitHub Actionsを開始しています',
        running: 'AIが変更案を作成しています',
        validating: '変更を検証しています',
        needs_input: '確認が必要です',
        failed: '自動処理を停止しました',
        pr_created: 'Pull Requestを作成しました',
        merged: 'マージ済み。Cloudflare Pagesの反映を待っています',
      }[status] || '処理状況を確認しています'
    )
  }

  function readMessage(payload) {
    if (!payload || typeof payload !== 'object') return ''
    return typeof payload.message === 'string' ? payload.message : ''
  }

  function rememberJob(jobId) {
    try {
      window.sessionStorage.setItem(savedJobKey, jobId)
    } catch {
      // sessionStorageを利用できない環境でも依頼自体は継続する。
    }
  }

  function readSavedJob() {
    try {
      return window.sessionStorage.getItem(savedJobKey)
    } catch {
      return ''
    }
  }

  function forgetJob() {
    try {
      window.sessionStorage.removeItem(savedJobKey)
    } catch {
      // sessionStorageを利用できない環境でも依頼自体は継続する。
    }
  }
})()
