import {
  assertSameOriginRequest,
  getFiles,
  handleApiError,
  jsonResponse,
  methodNotAllowed,
  products,
  readJson,
  requireAdmin,
  ShopApiError,
  type ShopEnv,
  type PagesContext,
} from '../_shared.ts'

export const PRODUCT_FILE_PART_SIZE_BYTES = 8 * 1024 * 1024
export const PRODUCT_FILE_MAX_SIZE_BYTES = 5 * 1024 * 1024 * 1024

type CreateUploadPayload = {
  productSlug?: unknown
  filename?: unknown
  size?: unknown
}

type CompleteUploadPayload = {
  productSlug?: unknown
  key?: unknown
  uploadId?: unknown
  parts?: unknown
}

type UploadedPart = {
  partNumber: number
  etag: string
}

export const onRequestGet = async ({ request, env }: PagesContext) => {
  try {
    await requireAdmin(request, env)
    return await handleProductFilesGet(request, env)
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestPost = async ({ request, env }: PagesContext) => {
  try {
    const identity = await requireAdmin(request, env)
    return await handleProductFilesPost(request, env, identity)
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestPut = async ({ request, env }: PagesContext) => {
  try {
    await requireAdmin(request, env)
    return await handleProductFilesPut(request, env)
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestDelete = async ({ request, env }: PagesContext) => {
  try {
    await requireAdmin(request, env)
    return await handleProductFilesDelete(request, env)
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestPatch = () =>
  methodNotAllowed(['GET', 'POST', 'PUT', 'DELETE'])

export async function handleProductFilesGet(request: Request, env: ShopEnv) {
  const url = new URL(request.url)
  const action = url.searchParams.get('action') || 'list'

  if (action === 'products') {
    return jsonResponse({ ok: true, products: getUploadProducts() })
  }

  const productSlug = normalizeProductSlug(url.searchParams.get('productSlug'))
  const product = getUploadProduct(productSlug)

  if (action === 'download') {
    const key = validateProductFileKey(
      product.slug,
      url.searchParams.get('key'),
    )
    const object = await getFiles(env).get(key)
    if (!object) {
      throw new ShopApiError(404, '商品ファイルが見つかりません。')
    }

    const filename = getStoredFilename(object.customMetadata, key)
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('Content-Type', 'application/zip')
    headers.set('Content-Disposition', contentDisposition(filename))
    headers.set('Cache-Control', 'private, no-store')
    headers.set('ETag', object.httpEtag)
    return new Response(object.body, { headers })
  }

  if (action !== 'list') {
    throw new ShopApiError(400, '商品ファイル操作を確認してください。')
  }

  const result = await getFiles(env).list({
    prefix: getProductFilePrefix(product.slug),
    limit: 100,
    include: ['customMetadata'],
  })
  const files = result.objects
    .map((object) => ({
      key: object.key,
      filename: getStoredFilename(object.customMetadata, object.key),
      size: object.size,
      uploadedAt: new Date(object.uploaded).toISOString(),
    }))
    .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))

  return jsonResponse({
    ok: true,
    product: { slug: product.slug, title: product.title },
    files,
    partSize: PRODUCT_FILE_PART_SIZE_BYTES,
  })
}

export async function handleProductFilesPost(
  request: Request,
  env: ShopEnv,
  identity: { email: string },
) {
  assertSameOriginRequest(request)
  const action = new URL(request.url).searchParams.get('action')

  if (action === 'create') {
    const payload = await readJson<CreateUploadPayload>(request)
    const prepared = prepareProductFileUpload(payload)
    const upload = await getFiles(env).createMultipartUpload(prepared.key, {
      httpMetadata: new Headers({
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(prepared.filename),
      }),
      customMetadata: {
        productSlug: prepared.productSlug,
        filename: encodeURIComponent(prepared.filename),
        declaredSize: String(prepared.size),
        uploadedBy: identity.email,
      },
    })

    return jsonResponse(
      {
        ok: true,
        key: upload.key,
        uploadId: upload.uploadId,
        partSize: PRODUCT_FILE_PART_SIZE_BYTES,
      },
      201,
    )
  }

  if (action === 'complete') {
    const payload = await readJson<CompleteUploadPayload>(request)
    const productSlug = normalizeProductSlug(payload.productSlug)
    getUploadProduct(productSlug)
    const key = validateProductFileKey(productSlug, payload.key)
    const uploadId = normalizeUploadId(payload.uploadId)
    const parts = normalizeUploadedParts(payload.parts)
    const upload = getFiles(env).resumeMultipartUpload(key, uploadId)
    const object = await upload.complete(parts)

    return jsonResponse({
      ok: true,
      file: {
        key: object.key,
        size: object.size,
        uploadedAt: new Date(object.uploaded).toISOString(),
      },
    })
  }

  throw new ShopApiError(400, '商品ファイル操作を確認してください。')
}

export async function handleProductFilesPut(request: Request, env: ShopEnv) {
  assertSameOriginRequest(request)
  const url = new URL(request.url)
  if (url.searchParams.get('action') !== 'part') {
    throw new ShopApiError(400, '商品ファイル操作を確認してください。')
  }

  const productSlug = normalizeProductSlug(url.searchParams.get('productSlug'))
  getUploadProduct(productSlug)
  const key = validateProductFileKey(productSlug, url.searchParams.get('key'))
  const uploadId = normalizeUploadId(url.searchParams.get('uploadId'))
  const partNumber = Number(url.searchParams.get('partNumber'))
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new ShopApiError(400, 'アップロードの分割番号が不正です。')
  }

  const chunk = await request.arrayBuffer()
  if (
    chunk.byteLength === 0 ||
    chunk.byteLength > PRODUCT_FILE_PART_SIZE_BYTES
  ) {
    throw new ShopApiError(413, 'アップロードする分割データが大きすぎます。')
  }
  if (partNumber === 1 && !hasZipSignature(chunk)) {
    throw new ShopApiError(400, 'ZIPファイルを選択してください。')
  }

  const upload = getFiles(env).resumeMultipartUpload(key, uploadId)
  const part = await upload.uploadPart(partNumber, chunk)
  return jsonResponse({ ok: true, part })
}

export async function handleProductFilesDelete(request: Request, env: ShopEnv) {
  assertSameOriginRequest(request)
  const url = new URL(request.url)
  if (url.searchParams.get('action') !== 'abort') {
    throw new ShopApiError(400, '商品ファイル操作を確認してください。')
  }

  const productSlug = normalizeProductSlug(url.searchParams.get('productSlug'))
  getUploadProduct(productSlug)
  const key = validateProductFileKey(productSlug, url.searchParams.get('key'))
  const uploadId = normalizeUploadId(url.searchParams.get('uploadId'))
  await getFiles(env).resumeMultipartUpload(key, uploadId).abort()
  return new Response(null, { status: 204 })
}

export function prepareProductFileUpload(payload: CreateUploadPayload) {
  const productSlug = normalizeProductSlug(payload.productSlug)
  getUploadProduct(productSlug)
  const filename = normalizeZipFilename(payload.filename)
  const size = Number(payload.size)
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > PRODUCT_FILE_MAX_SIZE_BYTES
  ) {
    throw new ShopApiError(
      413,
      '商品ファイルは1バイト以上、5 GiB以下にしてください。',
    )
  }

  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  return {
    productSlug,
    filename,
    size,
    key: `${getProductFilePrefix(productSlug)}${timestamp}-${suffix}.zip`,
  }
}

export function hasZipSignature(value: ArrayBuffer) {
  const bytes = new Uint8Array(value, 0, Math.min(value.byteLength, 4))
  return (
    bytes.length === 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  )
}

export function getProductFilePrefix(productSlug: string) {
  return `manual-products/${productSlug}/`
}

export function getUploadProducts() {
  return products
    .filter((product) => product.fulfillmentType !== 'physical')
    .map((product) => ({
      slug: product.slug,
      title: product.title,
      fulfillmentType: product.fulfillmentType,
    }))
}

function getUploadProduct(productSlug: string) {
  const product = products.find((candidate) => candidate.slug === productSlug)
  if (!product || product.fulfillmentType === 'physical') {
    throw new ShopApiError(404, 'ZIPを登録できる商品が見つかりません。')
  }
  return product
}

function normalizeProductSlug(value: unknown) {
  const slug = String(value || '').trim()
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw new ShopApiError(400, '商品を選択してください。')
  }
  return slug
}

function normalizeZipFilename(value: unknown) {
  const normalized = String(value || '')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!normalized || !/\.zip$/i.test(normalized)) {
    throw new ShopApiError(400, 'ZIPファイルを選択してください。')
  }
  if (normalized.length <= 180) return normalized
  return `${normalized.slice(0, 176)}.zip`
}

function validateProductFileKey(productSlug: string, value: unknown) {
  const key = String(value || '').trim()
  if (
    !key.startsWith(getProductFilePrefix(productSlug)) ||
    !/^[^\u0000-\u001f\u007f]+\.zip$/i.test(key)
  ) {
    throw new ShopApiError(400, '商品ファイルの指定が不正です。')
  }
  return key
}

function normalizeUploadId(value: unknown) {
  const uploadId = String(value || '').trim()
  if (
    uploadId.length < 1 ||
    uploadId.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(uploadId)
  ) {
    throw new ShopApiError(400, 'アップロードIDが不正です。')
  }
  return uploadId
}

function normalizeUploadedParts(value: unknown): UploadedPart[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    throw new ShopApiError(400, 'アップロード済みデータを確認してください。')
  }

  const parts = value
    .map((part) => ({
      partNumber: Number((part as { partNumber?: unknown })?.partNumber),
      etag: String((part as { etag?: unknown })?.etag || '').trim(),
    }))
    .sort((left, right) => left.partNumber - right.partNumber)

  parts.forEach((part, index) => {
    if (
      part.partNumber !== index + 1 ||
      part.etag.length < 1 ||
      part.etag.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(part.etag)
    ) {
      throw new ShopApiError(400, 'アップロード済みデータを確認してください。')
    }
  })
  return parts
}

function getStoredFilename(
  metadata: Record<string, string> | undefined,
  key: string,
) {
  const encoded = metadata?.filename
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      // Fall through to the generated object name.
    }
  }
  return key.split('/').at(-1) || 'product.zip'
}

function contentDisposition(filename: string) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
