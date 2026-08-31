const FILES_ENDPOINT = '/admin/api/product-files'
const REGISTERED_CMS = new WeakSet()

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

export function getProductEditorSlug(hash) {
  let decodedHash = String(hash || '')
  try {
    decodedHash = decodeURIComponent(decodedHash)
  } catch {
    return ''
  }

  const match = decodedHash.match(
    /(?:^|#)\/collections\/products\/entries\/([^/?#]+)/,
  )
  return match?.[1] || ''
}

export function getEntryValue(entry, fieldName) {
  const value = entry?.getIn?.(['data', fieldName])
  return typeof value?.toJS === 'function' ? value.toJS() : value
}

export function getProductFileContext(entry, hash) {
  const persistedSlug = getProductEditorSlug(hash)
  const hasEntryData = typeof entry?.getIn === 'function'
  const slug = hasEntryData
    ? String(getEntryValue(entry, 'slug') || '').trim()
    : persistedSlug
  const fulfillmentType = String(
    getEntryValue(entry, 'fulfillmentType') || '',
  ).trim()

  if (fulfillmentType === 'physical') {
    return {
      fulfillmentType,
      message: '物理発送商品には商品ZIPを設定しません。',
      persistedSlug,
      ready: false,
      slug,
    }
  }

  if (!persistedSlug) {
    return {
      fulfillmentType,
      message: '商品を一度保存してからZIPを設定してください。',
      persistedSlug,
      ready: false,
      slug,
    }
  }

  if (hasEntryData && (!slug || slug !== persistedSlug)) {
    return {
      fulfillmentType,
      message: 'URLスラッグを保存してからZIPを設定してください。',
      persistedSlug,
      ready: false,
      slug,
    }
  }

  return {
    fulfillmentType,
    message: '',
    persistedSlug,
    ready: true,
    slug,
  }
}

export function isZipFilename(filename) {
  return /\.zip$/i.test(String(filename || '').trim())
}

export function registerProductFileFieldType(cms, globals = window) {
  if (REGISTERED_CMS.has(cms)) return
  if (typeof cms?.registerFieldType !== 'function') {
    throw new Error('Sveltia CMSの商品ZIPフィールドを登録できませんでした。')
  }
  if (
    typeof globals?.createClass !== 'function' ||
    typeof globals?.h !== 'function'
  ) {
    throw new Error(
      'Sveltia CMSの商品ZIPコンポーネントを読み込めませんでした。',
    )
  }

  const { createClass, h } = globals
  const fetchImpl = (...args) => globals.fetch(...args)
  const getHash = () => globals.location?.hash || ''
  const getOrigin = () => globals.location?.origin || ''

  const ProductFileControl = createClass({
    getInitialState: function () {
      return {
        error: '',
        files: [],
        loading: false,
        progress: 0,
        selectedFile: null,
        status: '',
        uploading: false,
      }
    },

    componentDidMount: function () {
      this._mounted = true
      globals.addEventListener?.('beforeunload', this.handleBeforeUnload)
      void this.loadFiles()
    },

    componentDidUpdate: function (previousProps) {
      const previous = getProductFileContext(previousProps.entry, getHash())
      const current = getProductFileContext(this.props.entry, getHash())
      if (
        previous.slug !== current.slug ||
        previous.persistedSlug !== current.persistedSlug ||
        previous.fulfillmentType !== current.fulfillmentType
      ) {
        void this.loadFiles()
      }
    },

    componentWillUnmount: function () {
      this._mounted = false
      this._loadController?.abort()
      this._uploadController?.abort()
      globals.removeEventListener?.('beforeunload', this.handleBeforeUnload)
    },

    handleBeforeUnload: function (event) {
      if (!this._uploading) return
      event.preventDefault()
      event.returnValue = ''
    },

    loadFiles: async function () {
      const context = getProductFileContext(this.props.entry, getHash())
      this._loadController?.abort()

      if (!context.ready) {
        this.setState({ error: '', files: [], loading: false, status: '' })
        return
      }

      const controller = new globals.AbortController()
      this._loadController = controller
      this.setState({ error: '', loading: true })

      try {
        const response = await fetchImpl(
          buildFilesUrl(
            'list',
            { productSlug: context.persistedSlug },
            getOrigin(),
          ),
          { credentials: 'include', signal: controller.signal },
        )
        const payload = await readPayload(response)
        if (!response.ok) {
          throw new Error(payload.message || 'ZIPを読み込めませんでした。')
        }
        if (!this._mounted || controller.signal.aborted) return

        this.setState({
          error: '',
          files: Array.isArray(payload.files) ? payload.files : [],
          loading: false,
        })
      } catch (error) {
        if (controller.signal.aborted || !this._mounted) return
        this.setState({
          error:
            error instanceof Error
              ? error.message
              : 'ZIPを読み込めませんでした。',
          files: [],
          loading: false,
        })
      }
    },

    handleFileChange: function (event) {
      this.setState({
        error: '',
        selectedFile: event.currentTarget.files?.[0] || null,
        status: '',
      })
    },

    handleFileSelection: function (event) {
      this.props.onChange(event.currentTarget.value)
      this.setState({
        error: '',
        status: '商品ZIPを選択しました。右上の「保存」で確定してください。',
      })
    },

    clearFileSelection: function () {
      this.props.onChange('')
      this.setState({
        error: '',
        status:
          '商品ZIPの選択を解除しました。右上の「保存」で確定してください。',
      })
    },

    handleUpload: async function (event) {
      event.preventDefault()
      if (this._uploading) return

      const context = getProductFileContext(this.props.entry, getHash())
      const file = this.state.selectedFile

      if (!context.ready) {
        this.setState({ error: context.message, status: '' })
        return
      }
      if (!file || !isZipFilename(file.name)) {
        this.setState({
          error: 'ZIPファイルを選択してください。',
          status: '',
        })
        return
      }

      this._uploading = true
      const uploadController = new globals.AbortController()
      this._uploadController = uploadController
      this.setState({
        error: '',
        progress: 0,
        status: 'アップロードを開始しています。',
        uploading: true,
      })

      let upload = null
      try {
        const createResponse = await fetchImpl(
          buildFilesUrl('create', {}, getOrigin()),
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            signal: uploadController.signal,
            body: JSON.stringify({
              productSlug: context.persistedSlug,
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

        const partSize = Number(upload.partSize)
        if (!Number.isInteger(partSize) || partSize <= 0) {
          throw new Error('アップロード設定を取得できませんでした。')
        }

        const parts = []
        for (
          let offset = 0, partNumber = 1;
          offset < file.size;
          partNumber += 1
        ) {
          const chunk = file.slice(offset, offset + partSize)
          const part = await this.uploadPart(
            context.persistedSlug,
            upload,
            partNumber,
            chunk,
            uploadController.signal,
          )
          parts.push(part)
          offset += chunk.size
          if (this._mounted) {
            this.setState({
              progress: Math.round((offset / file.size) * 100),
              status: 'ZIPをアップロードしています。',
            })
          }
        }

        const completeResponse = await fetchImpl(
          buildFilesUrl('complete', {}, getOrigin()),
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            signal: uploadController.signal,
            body: JSON.stringify({
              productSlug: context.persistedSlug,
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

        const objectKey = String(completePayload.file?.key || upload.key || '')
        if (!objectKey) {
          throw new Error('アップロードしたZIPを選択できませんでした。')
        }

        this.props.onChange(objectKey)
        if (this._fileInput) this._fileInput.value = ''
        await this.loadFiles()
        if (this._mounted) {
          this.setState({
            error: '',
            selectedFile: null,
            status:
              'ZIPをアップロードして選択しました。右上の「保存」で確定してください。',
          })
        }
      } catch (error) {
        if (upload?.uploadId) {
          await fetchImpl(
            buildFilesUrl(
              'abort',
              {
                productSlug: context.persistedSlug,
                key: upload.key,
                uploadId: upload.uploadId,
              },
              getOrigin(),
            ),
            { method: 'DELETE', credentials: 'include' },
          ).catch(() => {})
        }
        if (this._mounted) {
          this.setState({
            error:
              error instanceof Error
                ? error.message
                : 'アップロードできませんでした。',
            status: '',
          })
        }
      } finally {
        this._uploading = false
        if (this._uploadController === uploadController) {
          this._uploadController = null
        }
        if (this._mounted) {
          this.setState({ progress: 0, uploading: false })
        }
      }
    },

    uploadPart: async function (
      productSlug,
      upload,
      partNumber,
      chunk,
      signal,
    ) {
      let lastError = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetchImpl(
            buildFilesUrl(
              'part',
              {
                productSlug,
                key: upload.key,
                uploadId: upload.uploadId,
                partNumber,
              },
              getOrigin(),
            ),
            {
              method: 'PUT',
              credentials: 'include',
              headers: { 'Content-Type': 'application/octet-stream' },
              signal,
              body: chunk,
            },
          )
          const payload = await readPayload(response)
          if (!response.ok || !payload.part) {
            throw new Error(
              payload.message ||
                `ZIPの${partNumber}番目を保存できませんでした。`,
            )
          }
          return payload.part
        } catch (error) {
          lastError = error
          if (attempt < 2) await delay(500 * 2 ** attempt)
        }
      }
      throw lastError
    },

    render: function () {
      const context = getProductFileContext(this.props.entry, getHash())
      const value = String(this.props.value || '')
      const selected = this.state.files.find((file) => file.key === value)
      const disabled = this.state.loading || this.state.uploading

      if (!context.ready) {
        return h(
          'div',
          {
            className: 'cms-product-file-field cms-product-file-field--notice',
            'data-cms-product-file-field': '',
          },
          h('p', {}, context.message),
        )
      }

      return h(
        'div',
        {
          className: 'cms-product-file-field',
          'data-cms-product-file-field': '',
          'aria-busy': String(disabled),
        },
        h(
          'div',
          { className: 'cms-product-file-current' },
          h('span', {}, '選択中'),
          value
            ? h(
                'div',
                {},
                h(
                  'strong',
                  { title: value },
                  selected?.filename || getFilename(value),
                ),
                h(
                  'button',
                  {
                    className: 'cms-product-file-icon-button',
                    type: 'button',
                    disabled: this.state.uploading,
                    onClick: this.clearFileSelection,
                    'aria-label': '商品ZIPの選択を解除',
                    title: '選択解除',
                  },
                  h(
                    'span',
                    {
                      className: 'material-symbols-outlined',
                      'aria-hidden': 'true',
                    },
                    'link_off',
                  ),
                ),
              )
            : h('p', {}, '未設定'),
        ),
        h(
          'form',
          {
            className: 'cms-product-file-upload',
            onSubmit: this.handleUpload,
          },
          h('input', {
            id: this.props.forID,
            className: [this.props.classNameWrapper, 'cms-product-file-input']
              .filter(Boolean)
              .join(' '),
            type: 'file',
            accept: '.zip,application/zip,application/x-zip-compressed',
            disabled,
            onChange: this.handleFileChange,
            ref: (element) => {
              this._fileInput = element
            },
          }),
          h(
            'button',
            {
              className: 'cms-product-file-upload-button',
              type: 'submit',
              disabled: disabled || !this.state.selectedFile,
            },
            h(
              'span',
              {
                className: 'material-symbols-outlined',
                'aria-hidden': 'true',
              },
              'upload',
            ),
            'アップロード',
          ),
        ),
        this.state.uploading &&
          h(
            'div',
            { className: 'cms-product-file-progress' },
            h('progress', { max: 100, value: this.state.progress }),
            h('span', {}, `${this.state.progress}%`),
          ),
        (this.state.status || this.state.error) &&
          h(
            'p',
            {
              className: `cms-product-file-status${
                this.state.error ? ' cms-product-file-status--error' : ''
              }`,
              'aria-live': 'polite',
            },
            this.state.error || this.state.status,
          ),
        h(
          'div',
          { className: 'cms-product-file-list-heading' },
          h('span', {}, '登録済みZIP'),
          h(
            'button',
            {
              className: 'cms-product-file-icon-button',
              type: 'button',
              disabled,
              onClick: this.loadFiles,
              'aria-label': '登録済みZIPを再読み込み',
              title: '再読み込み',
            },
            h(
              'span',
              {
                className: 'material-symbols-outlined',
                'aria-hidden': 'true',
              },
              'refresh',
            ),
          ),
        ),
        h(
          'div',
          { className: 'cms-product-file-list' },
          this.renderFileList(context, value, disabled),
        ),
      )
    },

    renderFileList: function (context, value, disabled) {
      if (this.state.loading) return h('p', {}, 'ZIPを読み込んでいます。')
      if (this.state.files.length === 0) {
        return h('p', {}, '登録済みのZIPはありません。')
      }

      return this.state.files.map((file, index) =>
        h(
          'div',
          { className: 'cms-product-file-row', key: file.key },
          h(
            'label',
            { htmlFor: `${this.props.forID}-${index}` },
            h('input', {
              id: `${this.props.forID}-${index}`,
              type: 'radio',
              name: `${this.props.forID}-selection`,
              value: file.key,
              checked: value === file.key,
              disabled,
              onChange: this.handleFileSelection,
            }),
            h(
              'span',
              {},
              h('strong', {}, file.filename),
              h(
                'small',
                {},
                `${formatBytes(file.size)} / ${formatUploadedAt(
                  file.uploadedAt,
                )}`,
              ),
            ),
          ),
          h(
            'a',
            {
              className: 'cms-product-file-icon-button',
              href: buildFilesUrl(
                'download',
                { productSlug: context.persistedSlug, key: file.key },
                getOrigin(),
              ),
              download: '',
              'aria-label': `${file.filename}をダウンロード`,
              title: 'ダウンロード',
            },
            h(
              'span',
              {
                className: 'material-symbols-outlined',
                'aria-hidden': 'true',
              },
              'download',
            ),
          ),
        ),
      )
    },
  })

  cms.registerFieldType('shop_product_file', ProductFileControl)
  REGISTERED_CMS.add(cms)
}

function getFilename(key) {
  return (
    String(key || '')
      .split('/')
      .filter(Boolean)
      .pop() || String(key || '')
  )
}

function formatUploadedAt(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '日時不明'
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
