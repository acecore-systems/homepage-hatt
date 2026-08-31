;(function initCmsAiPanel() {
  const jobsEndpoint = '/admin/api/ai/jobs'
  const conversationsEndpoint = '/admin/api/ai/conversations'
  const savedConversationKey = 'hatt-cms-ai-conversation-id'
  const launcher = document.createElement('button')
  launcher.className = 'cms-ai-launcher'
  launcher.type = 'button'
  launcher.setAttribute('aria-controls', 'cms-ai-panel')
  launcher.setAttribute('aria-expanded', 'false')
  launcher.innerHTML =
    '<span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>AIと相談'

  const panel = document.createElement('aside')
  panel.className = 'cms-ai-panel'
  panel.hidden = true
  panel.id = 'cms-ai-panel'
  panel.setAttribute('aria-label', 'CMS AIとの会話')
  panel.innerHTML = [
    '<header class="cms-ai-panel__header">',
    '  <div>',
    '    <h2 class="cms-ai-panel__title">CMS AI</h2>',
    '    <p class="cms-ai-panel__description">会話を続けながら、同じPull Requestを調整できます。</p>',
    '  </div>',
    '  <button class="cms-ai-panel__close" type="button" aria-label="CMS AIパネルを閉じる">×</button>',
    '</header>',
    '<div class="cms-ai-panel__body">',
    '  <div class="cms-ai-conversation-bar">',
    '    <label class="cms-ai-conversation-bar__select">会話履歴',
    '      <select class="cms-ai-conversation-select" aria-label="会話履歴"><option value="">新しい会話</option></select>',
    '    </label>',
    '    <button class="cms-ai-new-conversation" type="button"><span class="material-symbols-outlined" aria-hidden="true">add</span>新規</button>',
    '  </div>',
    '  <ol class="cms-ai-messages" aria-live="polite"></ol>',
    '  <form class="cms-ai-form">',
    '    <div class="cms-ai-conversation-setup">',
    '      <label>対象URL',
    '        <input name="targetUrl" type="url" required />',
    '      </label>',
    '      <p class="cms-ai-form__hint">会話中はこのページと同じ変更branchを使います。</p>',
    '    </div>',
    '    <label class="cms-ai-form__message-label">メッセージ',
    '      <textarea name="instruction" required maxlength="4000" placeholder="例: このページの見出しの余白を少し狭くして"></textarea>',
    '    </label>',
    '    <div class="cms-ai-form__actions">',
    '      <label>考える深さ',
    '        <select name="reasoningEffort" required>',
    '          <option value="low">低</option>',
    '          <option value="medium" selected>標準</option>',
    '          <option value="high">高</option>',
    '        </select>',
    '      </label>',
    '      <button class="cms-ai-form__submit" type="submit">会話を開始</button>',
    '    </div>',
    '    <p class="cms-ai-form__hint">高いほど丁寧に考えますが、完了時間と利用量が増える場合があります。</p>',
    '    <p class="cms-ai-form__status" role="status"></p>',
    '  </form>',
    '</div>',
  ].join('')

  document.body.append(launcher, panel)

  const form = panel.querySelector('.cms-ai-form')
  const close = panel.querySelector('.cms-ai-panel__close')
  const submit = panel.querySelector('.cms-ai-form__submit')
  const target = form.elements.targetUrl
  const instruction = form.elements.instruction
  const effort = form.elements.reasoningEffort
  const setup = panel.querySelector('.cms-ai-conversation-setup')
  const messages = panel.querySelector('.cms-ai-messages')
  const conversationSelect = panel.querySelector('.cms-ai-conversation-select')
  const newConversation = panel.querySelector('.cms-ai-new-conversation')
  const formStatus = panel.querySelector('.cms-ai-form__status')
  let conversation = null
  let conversationSummaries = []
  let initialized = false
  let timer = 0

  target.value = window.location.origin + '/'

  launcher.addEventListener('click', () => {
    panel.hidden = false
    launcher.setAttribute('aria-expanded', 'true')

    if (!initialized) {
      initialized = true
      initialize().catch(() => {
        renderStatus('会話履歴を読み込めませんでした。', true)
      })
    } else {
      focusComposer()
    }
  })

  close.addEventListener('click', () => {
    panel.hidden = true
    launcher.setAttribute('aria-expanded', 'false')
  })

  newConversation.addEventListener('click', () => {
    startNewConversation()
  })

  conversationSelect.addEventListener('change', () => {
    const conversationId = conversationSelect.value

    if (!conversationId) {
      startNewConversation()
      return
    }

    clearTimer()
    loadConversation(conversationId, { showLoading: true }).catch(() => {
      renderStatus('会話を読み込めませんでした。', true)
    })
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()

    if (conversation && isPending(conversation.status)) return

    clearTimer()
    submit.disabled = true
    renderStatus(
      conversation ? 'メッセージを送信しています。' : '会話を開始しています。',
      false,
    )

    try {
      const data = new FormData(form)
      const endpoint = conversation
        ? conversationsEndpoint +
          '/' +
          encodeURIComponent(conversation.id) +
          '/messages'
        : jobsEndpoint
      const response = await fetch(endpoint, {
        body: data,
        credentials: 'include',
        method: 'POST',
      })
      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(readMessage(payload) || 'メッセージを送信できません。')
      }

      instruction.value = ''

      if (payload.conversation) {
        setConversation(payload.conversation)
      } else if (payload.job && payload.job.conversationId) {
        await loadConversation(payload.job.conversationId)
      } else {
        throw new Error('開始した会話を確認できません。')
      }

      await loadConversationList()
      pollConversation(conversation.id)
    } catch (error) {
      renderStatus(
        error instanceof Error ? error.message : 'メッセージを送信できません。',
        true,
      )
    } finally {
      renderComposer({ preserveStatus: true })
    }
  })

  async function initialize() {
    await loadConversationList()
    const savedConversationId = readSavedConversation()
    const initialConversationId = conversationSummaries.some(
      (item) => item.id === savedConversationId,
    )
      ? savedConversationId
      : conversationSummaries[0]?.id || ''

    if (initialConversationId) {
      await loadConversation(initialConversationId)
      return
    }

    startNewConversation()
  }

  async function loadConversationList() {
    const response = await fetch(conversationsEndpoint, {
      credentials: 'include',
    })
    const payload = await response.json().catch(() => ({}))

    if (!response.ok || !Array.isArray(payload.conversations)) {
      throw new Error(readMessage(payload) || '会話履歴を読み込めません。')
    }

    conversationSummaries = payload.conversations
    renderConversationList()
  }

  async function loadConversation(conversationId, options = {}) {
    if (options.showLoading) {
      renderStatus('会話を読み込んでいます。', false)
    }

    const response = await fetch(
      conversationsEndpoint + '/' + encodeURIComponent(conversationId),
      { credentials: 'include' },
    )
    const payload = await response.json().catch(() => ({}))

    if (response.status === 404) {
      forgetConversation()
      startNewConversation()
      return
    }

    if (!response.ok || !payload.conversation) {
      throw new Error(readMessage(payload) || '会話を読み込めません。')
    }

    setConversation(payload.conversation)

    if (isPending(payload.conversation.status)) {
      if (options.schedulePolling !== false) {
        pollConversation(payload.conversation.id)
      }
    } else {
      clearTimer()
    }
  }

  function pollConversation(conversationId) {
    clearTimer()
    timer = window.setInterval(async () => {
      try {
        await loadConversation(conversationId, { schedulePolling: false })

        if (conversation && !isPending(conversation.status)) {
          await loadConversationList().catch(() => {})
        }
      } catch {
        // 一時的な通信失敗は次のpollで回復させる。
      }
    }, 3000)
  }

  function setConversation(nextConversation) {
    conversation = nextConversation
    rememberConversation(nextConversation.id)
    effort.value = nextConversation.reasoningEffort || 'medium'
    renderConversation()
    renderConversationList()
    renderComposer()
  }

  function startNewConversation() {
    clearTimer()
    conversation = null
    forgetConversation()
    target.value = window.location.origin + '/'
    instruction.value = ''
    effort.value = 'medium'
    renderConversation()
    renderConversationList()
    renderComposer()
    focusComposer()
  }

  function renderConversationList() {
    const selectedId = conversation?.id || ''
    conversationSelect.replaceChildren()
    conversationSelect.append(new Option('新しい会話', ''))

    for (const item of conversationSummaries) {
      if (!item || typeof item.id !== 'string') continue
      const title = typeof item.title === 'string' ? item.title : 'CMS AIの会話'
      const option = new Option(title, item.id)
      conversationSelect.append(option)
    }

    conversationSelect.value = selectedId
  }

  function renderConversation() {
    messages.replaceChildren()
    setup.hidden = Boolean(conversation)

    if (!conversation || !Array.isArray(conversation.jobs)) {
      const empty = document.createElement('li')
      empty.className = 'cms-ai-messages__empty'
      empty.textContent =
        '対象ページと最初の依頼を送ると会話が始まります。結果を見て、そのまま追加の修正を頼めます。'
      messages.append(empty)
      return
    }

    for (const job of conversation.jobs) {
      messages.append(renderTurn(job))
    }

    window.requestAnimationFrame(() => {
      messages.scrollTop = messages.scrollHeight
    })
  }

  function renderTurn(job) {
    const turn = document.createElement('li')
    turn.className = 'cms-ai-turn'

    const userMessage = document.createElement('article')
    userMessage.className = 'cms-ai-message cms-ai-message--user'
    const userMeta = document.createElement('p')
    userMeta.className = 'cms-ai-message__meta'
    userMeta.textContent =
      'あなた · Turn ' +
      String(job.turnNumber || '') +
      ' · ' +
      effortLabel(job.reasoningEffort)
    const userText = document.createElement('p')
    userText.className = 'cms-ai-message__text'
    userText.textContent = job.instruction || ''
    userMessage.append(userMeta, userText)

    const assistantMessage = document.createElement('article')
    assistantMessage.className = 'cms-ai-message cms-ai-message--assistant'
    const assistantMeta = document.createElement('p')
    assistantMeta.className = 'cms-ai-message__meta'
    assistantMeta.textContent = 'CMS AI · ' + statusLabel(job.status)
    const assistantText = document.createElement('p')
    assistantText.className = 'cms-ai-message__text'
    assistantText.textContent =
      (job.status === 'failed' ? job.errorMessage : '') ||
      job.assistantMessage ||
      job.clarification ||
      job.summary ||
      pendingMessage(job.status)
    assistantMessage.append(assistantMeta, assistantText)

    if (Array.isArray(job.changedPaths) && job.changedPaths.length > 0) {
      const paths = document.createElement('ul')
      paths.className = 'cms-ai-message__paths'

      for (const path of job.changedPaths) {
        const item = document.createElement('li')
        item.textContent = path
        paths.append(item)
      }

      assistantMessage.append(paths)
    }

    if (typeof job.prUrl === 'string' && job.prUrl) {
      const link = document.createElement('a')
      link.className = 'cms-ai-message__link'
      link.href = job.prUrl
      link.target = '_blank'
      link.rel = 'noreferrer'
      link.textContent = 'Pull Requestを開く'
      assistantMessage.append(link)
    }

    turn.append(userMessage, assistantMessage)
    return turn
  }

  function renderComposer(options = {}) {
    const pending = Boolean(conversation && isPending(conversation.status))
    const merged = conversation?.status === 'merged'
    const atLimit = Number(conversation?.jobs?.length || 0) >= 30
    submit.disabled = pending || merged || atLimit
    instruction.disabled = pending || merged || atLimit
    effort.disabled = pending || merged || atLimit
    instruction.placeholder = conversation
      ? '例: もう少し余白を狭くして、見出しはそのままにして'
      : '例: このページの見出しの余白を少し狭くして'
    submit.textContent = pending
      ? '処理中…'
      : conversation
        ? '送信'
        : '会話を開始'

    if (options.preserveStatus) {
      return
    }

    if (pending) {
      renderStatus(statusLabel(conversation.status), false)
    } else if (merged) {
      renderStatus(
        'マージ済みです。続きは新しい会話で依頼してください。',
        false,
      )
    } else if (atLimit) {
      renderStatus(
        '会話の上限に達しました。新しい会話を開始してください。',
        false,
      )
    } else {
      renderStatus('', false)
    }
  }

  function renderStatus(message, error) {
    formStatus.textContent = message
    formStatus.classList.toggle('cms-ai-form__status--error', Boolean(error))
  }

  function focusComposer() {
    window.setTimeout(() => {
      if (conversation) instruction.focus()
      else target.focus()
    }, 0)
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
        running: '変更案を作成しています',
        validating: '変更を検証しています',
        needs_input: '返答を待っています',
        failed: '自動処理を停止しました',
        pr_created: 'Pull Requestを更新しました',
        merged: 'マージ済み',
      }[status] || '状況を確認しています'
    )
  }

  function pendingMessage(status) {
    return isPending(status)
      ? '依頼を確認しています。完了するとここに返答が表示されます。'
      : '処理結果を確認できません。'
  }

  function effortLabel(value) {
    return { high: '高', low: '低', medium: '標準' }[value] || '標準'
  }

  function readMessage(payload) {
    if (!payload || typeof payload !== 'object') return ''
    return typeof payload.message === 'string' ? payload.message : ''
  }

  function rememberConversation(conversationId) {
    try {
      window.localStorage.setItem(savedConversationKey, conversationId)
    } catch {
      // localStorageを利用できない環境でも会話自体は継続する。
    }
  }

  function readSavedConversation() {
    try {
      return window.localStorage.getItem(savedConversationKey) || ''
    } catch {
      return ''
    }
  }

  function forgetConversation() {
    try {
      window.localStorage.removeItem(savedConversationKey)
    } catch {
      // localStorageを利用できない環境でも会話自体は継続する。
    }
  }

  renderConversation()
  renderConversationList()
  renderComposer()
})()
