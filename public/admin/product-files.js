const FILES_ENDPOINT = '/admin/api/product-files'

export function buildFilesUrl(action, parameters = {}, origin = '') {
  const url = new URL(FILES_ENDPOINT, origin || 'https://cms.invalid')
  if (action && action !== 'list') url.searchParams.set('action', action)
  Object.entries(parameters).forEach(([key, value]) => {
    url.searchParams.set(key, String(value))
  })
  return `${url.pathname}${url.search}`
}

export function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

export function getCurrentProductSlug(hash, availableSlugs) {
  let decodedHash = String(hash || '')
  try {
    decodedHash = decodeURIComponent(decodedHash)
  } catch {
    return ''
  }

  if (!decodedHash.includes('/collections/products')) return ''
  const segments = decodedHash.split(/[/?#]/).filter(Boolean)
  return (
    [...availableSlugs]
      .sort((left, right) => right.length - left.length)
      .find((slug) => segments.includes(slug)) || ''
  )
}

export function isZipFilename(filename) {
  return /\.zip$/i.test(String(filename || '').trim())
}

function initializeProductFiles() {
  const openButton = document.querySelector('[data-cms-product-files-open]')
  const dialog = document.querySelector('[data-cms-product-files-dialog]')
  const closeButton = document.querySelector('[data-cms-product-files-close]')
  const form = document.querySelector('[data-cms-product-file-upload]')
  const productSelect = document.querySelector(
    '[data-cms-product-file-product]',
  )
  const fileInput = document.querySelector('[data-cms-product-file-input]')
  const refreshButton = document.querySelector(
    '[data-cms-product-files-refresh]',
  )
  const list = document.querySelector('[data-cms-product-files-list]')
  const status = document.querySelector('[data-cms-product-files-status]')
  const progress = document.querySelector('[data-cms-product-file-progress]')
  const progressBar = progress?.querySelector('progress')
  const progressText = progress?.querySelector('span')
  const submitButton = form?.querySelector('button[type="submit"]')

  if (
    !openButton ||
    !dialog ||
    !closeButton ||
    !form ||
    !productSelect ||
    !fileInput ||
    !refreshButton ||
    !list ||
    !status ||
    !progress ||
    !submitButton
  ) {
    return
  }

  let uploading = false

  function setStatus(message, isError = false) {
    status.textContent = message || ''
    status.classList.toggle('cms-product-files-status--error', isError)
  }

  function setBusy(value) {
    uploading = value
    dialog.setAttribute('aria-busy', String(value))
    submitButton.disabled = value
    productSelect.disabled = value
    fileInput.disabled = value
    refreshButton.disabled = value
    closeButton.disabled = value
  }

  function setProgress(value) {
    progressBar.value = value
    progressText.textContent = `${value}%`
  }

  async function openDialog() {
    if (!dialog.open) dialog.showModal()
    setStatus('商品を読み込んでいます。')
    await loadProducts()
  }

  async function loadProducts() {
    const previousValue = productSelect.value
    const response = await fetch(buildFilesUrl('products'), {
      credentials: 'include',
    })
    const payload = await readPayload(response)
    if (!response.ok) {
      setStatus(payload.message || '商品を読み込めませんでした。', true)
      return
    }

    const products = Array.isArray(payload.products) ? payload.products : []
    productSelect.replaceChildren(new Option('商品を選択', ''))
    products.forEach((product) => {
      productSelect.append(new Option(product.title, product.slug))
    })

    const availableSlugs = products.map((product) => product.slug)
    const currentSlug = getCurrentProductSlug(
      window.location.hash,
      availableSlugs,
    )
    if (availableSlugs.includes(previousValue)) {
      productSelect.value = previousValue
    } else if (currentSlug) {
      productSelect.value = currentSlug
    } else if (products.length === 1) {
      productSelect.value = products[0].slug
    }

    setStatus('')
    await loadFiles()
  }

  async function loadFiles() {
    const productSlug = productSelect.value
    list.replaceChildren()
    if (!productSlug) {
      list.append(buildMessage('商品を選択してください。'))
      return
    }

    list.append(buildMessage('ZIPを読み込んでいます。'))
    const response = await fetch(
      buildFilesUrl('list', { productSlug }, window.location.origin),
      { credentials: 'include' },
    )
    const payload = await readPayload(response)
    if (!response.ok) {
      list.replaceChildren()
      setStatus(payload.message || 'ZIPを読み込めませんでした。', true)
      return
    }

    renderFiles(payload.files || [], productSlug)
    setStatus('')
  }

  function renderFiles(files, productSlug) {
    list.replaceChildren()
    if (files.length === 0) {
      list.append(buildMessage('登録済みのZIPはありません。'))
      return
    }

    files.forEach((file) => {
      const row = document.createElement('div')
      row.className = 'cms-product-file-row'
      const details = document.createElement('div')
      const name = document.createElement('strong')
      name.textContent = file.filename
      const meta = document.createElement('span')
      meta.textContent = `${formatBytes(file.size)} / ${new Intl.DateTimeFormat(
        'ja-JP',
        { dateStyle: 'medium', timeStyle: 'short' },
      ).format(new Date(file.uploadedAt))}`
      details.append(name, meta)

      const download = document.createElement('a')
      download.className = 'cms-secondary-button'
      download.href = buildFilesUrl(
        'download',
        { productSlug, key: file.key },
        window.location.origin,
      )
      download.download = ''
      const icon = document.createElement('span')
      icon.className = 'material-symbols-outlined'
      icon.setAttribute('aria-hidden', 'true')
      icon.textContent = 'download'
      download.append(icon, 'ダウンロード')
      row.append(details, download)
      list.append(row)
    })
  }

  async function uploadFile(event) {
    event.preventDefault()
    const file = fileInput.files?.[0]
    const productSlug = productSelect.value
    if (!file || !productSlug) {
      setStatus('商品とZIPファイルを選択してください。', true)
      return
    }
    if (!isZipFilename(file.name)) {
      setStatus('ZIPファイルを選択してください。', true)
      return
    }

    setBusy(true)
    setProgress(0)
    progress.hidden = false
    setStatus('アップロードを開始しています。')

    let upload = null
    try {
      const createResponse = await fetch(
        buildFilesUrl('create', {}, window.location.origin),
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productSlug,
            filename: file.name,
            size: file.size,
          }),
        },
      )
      const createPayload = await readPayload(createResponse)
      if (!createResponse.ok) {
        throw new Error(
          createPayload.message || 'アップロードを開始できませんでした。',
        )
      }
      upload = createPayload

      const parts = []
      for (
        let offset = 0, partNumber = 1;
        offset < file.size;
        partNumber += 1
      ) {
        const chunk = file.slice(offset, offset + upload.partSize)
        const part = await uploadPart(productSlug, upload, partNumber, chunk)
        parts.push(part)
        offset += chunk.size
        setProgress(Math.round((offset / file.size) * 100))
      }

      const completeResponse = await fetch(
        buildFilesUrl('complete', {}, window.location.origin),
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productSlug,
            key: upload.key,
            uploadId: upload.uploadId,
            parts,
          }),
        },
      )
      const completePayload = await readPayload(completeResponse)
      if (!completeResponse.ok) {
        throw new Error(
          completePayload.message || 'アップロードを完了できませんでした。',
        )
      }

      fileInput.value = ''
      setStatus('ZIPをアップロードしました。')
      await loadFiles()
    } catch (error) {
      if (upload?.uploadId) {
        await fetch(
          buildFilesUrl(
            'abort',
            {
              productSlug,
              key: upload.key,
              uploadId: upload.uploadId,
            },
            window.location.origin,
          ),
          { method: 'DELETE', credentials: 'include' },
        ).catch(() => {})
      }
      setStatus(
        error instanceof Error
          ? error.message
          : 'アップロードできませんでした。',
        true,
      )
    } finally {
      setBusy(false)
      progress.hidden = true
    }
  }

  async function uploadPart(productSlug, upload, partNumber, chunk) {
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(
          buildFilesUrl(
            'part',
            {
              productSlug,
              key: upload.key,
              uploadId: upload.uploadId,
              partNumber,
            },
            window.location.origin,
          ),
          {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: chunk,
          },
        )
        const payload = await readPayload(response)
        if (!response.ok || !payload.part) {
          throw new Error(
            payload.message || `ZIPの${partNumber}番目を保存できませんでした。`,
          )
        }
        return payload.part
      } catch (error) {
        lastError = error
        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * 2 ** attempt),
          )
        }
      }
    }
    throw lastError
  }

  function closeDialog() {
    if (!uploading) dialog.close()
  }

  openButton.addEventListener('click', openDialog)
  closeButton.addEventListener('click', closeDialog)
  refreshButton.addEventListener('click', loadProducts)
  productSelect.addEventListener('change', loadFiles)
  form.addEventListener('submit', uploadFile)
  dialog.addEventListener('cancel', (event) => {
    if (uploading) event.preventDefault()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog()
  })
  window.addEventListener('beforeunload', (event) => {
    if (!uploading) return
    event.preventDefault()
    event.returnValue = ''
  })
}

function buildMessage(message) {
  const paragraph = document.createElement('p')
  paragraph.textContent = message
  return paragraph
}

async function readPayload(response) {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    return {
      message:
        'Cloudflare Accessのセッションが切れています。ページを再読み込みしてください。',
    }
  }
  return response.json()
}

if (typeof document !== 'undefined') initializeProductFiles()
