import { SHOP_PRODUCTS, SHOP_SETTINGS } from './_catalog.generated'

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>
  run(): Promise<{ meta?: { changes?: number } }>
}

export type D1Database = {
  prepare(query: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>
}

type R2ObjectBody = {
  body: ReadableStream
  httpEtag: string
  writeHttpMetadata(headers: Headers): void
}

export type R2Bucket = {
  get(key: string): Promise<R2ObjectBody | null>
}

export type ShopEnv = {
  SHOP_DB?: D1Database
  SHOP_FILES?: R2Bucket
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  SHOP_ADMIN_PASSWORD_HASH?: string
  SHOP_ADMIN_SESSION_SECRET?: string
  SHOP_DOWNLOAD_TOKEN_SECRET?: string
}

export type PagesContext = {
  request: Request
  env: ShopEnv
  params?: Record<string, string | string[]>
}

export type FulfillmentType = 'digital' | 'manual' | 'physical'
type ProductStatus = 'draft' | 'published' | 'sold_out'

export type ShopProduct = {
  slug: string
  title: string
  category: string
  summary: string
  description?: string
  images?: { src: string; alt?: string }[]
  priceJpy: number
  status: ProductStatus
  fulfillmentType: FulfillmentType
  stock: number
  maxQuantity: number
  r2ObjectKey?: string
  shippingProfileId?: string
  taxCode?: string
  externalUrl?: string
  features?: string[]
  order?: number
  featured?: boolean
}

type ShippingProfile = {
  id: string
  label: string
  description?: string
  amountJpy: number
  freeAboveJpy?: number
  countries?: string[]
}

export type ShopSettings = {
  enabled: boolean
  checkoutEnabled: boolean
  currency: 'JPY'
  stripeTaxEnabled: boolean
  allowedCountries?: string[]
  shippingProfiles?: ShippingProfile[]
  businessName?: string
  sellerName?: string
  sellerAddress?: string
  sellerPhone?: string
  sellerEmail?: string
  returnsPolicy?: string
  privacyPolicy?: string
  terms?: string
}

export type CheckoutCartItem = {
  productId?: unknown
  quantity?: unknown
}

export type ValidatedCartItem = {
  product: ShopProduct
  quantity: number
  lineTotalJpy: number
}

export type ShippingQuote = {
  required: boolean
  amountJpy: number
  profile?: ShippingProfile
}

export type OrderRow = {
  id: string
  stripe_checkout_session_id: string | null
  stripe_payment_intent_id: string | null
  customer_email: string | null
  customer_name: string | null
  currency: string
  subtotal_jpy: number
  shipping_jpy: number
  tax_jpy: number
  total_jpy: number
  payment_status: string
  fulfillment_status: string
  shipping_address_json: string | null
  tracking_number: string | null
  manual_note: string | null
  refund_note: string | null
  created_at: string
  updated_at: string
  paid_at: string | null
  canceled_at: string | null
}

export type OrderItemRow = {
  id: string
  order_id: string
  product_slug: string
  title: string
  category: string
  fulfillment_type: FulfillmentType
  quantity: number
  unit_price_jpy: number
  total_price_jpy: number
  r2_object_key: string | null
  shipping_profile_id: string | null
  item_status: string
  created_at: string
}

export const products = SHOP_PRODUCTS as readonly unknown[] as ShopProduct[]
export const settings = SHOP_SETTINGS as ShopSettings
export const productBySlug = new Map(
  products.map((product) => [product.slug, product]),
)

const ADMIN_COOKIE = 'hatt_shop_admin'
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60
const DOWNLOAD_TOKEN_TTL_SECONDS = 24 * 60 * 60

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

export function methodNotAllowed(methods: string[]) {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: methods.join(', ') },
  })
}

export function getDb(env: ShopEnv) {
  if (!env.SHOP_DB) throw new ShopApiError(503, 'SHOP_DBが未設定です。')
  return env.SHOP_DB
}

export function getFiles(env: ShopEnv) {
  if (!env.SHOP_FILES) throw new ShopApiError(503, 'SHOP_FILESが未設定です。')
  return env.SHOP_FILES
}

export class ShopApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export function handleApiError(error: unknown) {
  if (error instanceof ShopApiError) {
    return jsonResponse({ ok: false, message: error.message }, error.status)
  }

  console.error('Shop API failed:', error)
  return jsonResponse(
    { ok: false, message: 'ショップ機能を一時的に利用できません。' },
    500,
  )
}

export async function readJson<T>(request: Request): Promise<T> {
  const payload = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object') {
    throw new ShopApiError(400, 'リクエスト内容を確認してください。')
  }
  return payload as T
}

export function assertSameOriginRequest(request: Request) {
  const origin = request.headers.get('Origin')
  if (!origin) return

  const requestUrl = new URL(request.url)
  if (new URL(origin).hostname !== requestUrl.hostname) {
    throw new ShopApiError(403, '許可されていないリクエストです。')
  }
}

export function assertCheckoutReady() {
  if (!settings.enabled) {
    throw new ShopApiError(503, 'ショップは現在利用できません。')
  }

  if (!settings.checkoutEnabled || !hasRequiredLegalFields(settings)) {
    throw new ShopApiError(
      503,
      '決済は準備中です。ショップ設定の販売者情報と規約を確認してください。',
    )
  }
}

function hasRequiredLegalFields(shopSettings: ShopSettings) {
  return [
    shopSettings.businessName,
    shopSettings.sellerName,
    shopSettings.sellerAddress,
    shopSettings.sellerPhone,
    shopSettings.sellerEmail,
    shopSettings.returnsPolicy,
    shopSettings.privacyPolicy,
    shopSettings.terms,
  ].every((value) => String(value || '').trim().length > 0)
}

export function normalizeCartItems(items: unknown): CheckoutCartItem[] {
  if (!Array.isArray(items)) {
    throw new ShopApiError(400, 'カートが空です。')
  }

  return items.slice(0, 20).map((item) => {
    if (!item || typeof item !== 'object') {
      throw new ShopApiError(400, 'カート内容を確認してください。')
    }
    return item as CheckoutCartItem
  })
}

export function validateCart(items: CheckoutCartItem[]) {
  const merged = new Map<string, number>()

  for (const item of items) {
    const productId = String(item.productId || '').trim()
    const quantity = Number(item.quantity || 0)

    if (!/^[a-z0-9][a-z0-9_-]*$/.test(productId)) {
      throw new ShopApiError(400, '商品IDを確認してください。')
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ShopApiError(400, '数量を確認してください。')
    }

    merged.set(productId, (merged.get(productId) ?? 0) + quantity)
  }

  const validated = [...merged.entries()].map(([productId, quantity]) => {
    const product = productBySlug.get(productId)
    if (!product || product.status === 'draft') {
      throw new ShopApiError(400, '購入できない商品が含まれています。')
    }
    if (product.status === 'sold_out') {
      throw new ShopApiError(409, `${product.title}は売り切れです。`)
    }
    if (product.priceJpy <= 0) {
      throw new ShopApiError(
        400,
        `${product.title}はStripe決済対象外の商品です。`,
      )
    }
    if (quantity > product.maxQuantity) {
      throw new ShopApiError(
        400,
        `${product.title}は1注文あたり${product.maxQuantity}点までです。`,
      )
    }
    if (product.fulfillmentType === 'digital' && !product.r2ObjectKey) {
      throw new ShopApiError(
        503,
        `${product.title}の配布ファイルが未設定です。`,
      )
    }
    if (product.fulfillmentType === 'physical' && !product.shippingProfileId) {
      throw new ShopApiError(503, `${product.title}の配送設定が未設定です。`)
    }

    return {
      product,
      quantity,
      lineTotalJpy: product.priceJpy * quantity,
    }
  })

  if (validated.length === 0) {
    throw new ShopApiError(400, 'カートが空です。')
  }

  return validated
}

export function getSubtotal(items: ValidatedCartItem[]) {
  return items.reduce((sum, item) => sum + item.lineTotalJpy, 0)
}

export function resolveShipping(items: ValidatedCartItem[]) {
  const physicalItems = items.filter(
    (item) => item.product.fulfillmentType === 'physical',
  )
  if (physicalItems.length === 0) {
    return { required: false, amountJpy: 0 } satisfies ShippingQuote
  }

  const subtotal = getSubtotal(items)
  const profiles = settings.shippingProfiles ?? []
  const matchedProfiles = physicalItems.map((item) => {
    const profile = profiles.find(
      (candidate) => candidate.id === item.product.shippingProfileId,
    )
    if (!profile) {
      throw new ShopApiError(
        503,
        `${item.product.title}の配送設定が見つかりません。`,
      )
    }
    return profile
  })
  const profile = matchedProfiles.sort((a, b) => b.amountJpy - a.amountJpy)[0]
  const amountJpy =
    profile.freeAboveJpy && subtotal >= profile.freeAboveJpy
      ? 0
      : profile.amountJpy

  return { required: true, amountJpy, profile } satisfies ShippingQuote
}

export async function ensureStockRows(db: D1Database) {
  const now = new Date().toISOString()
  await db.batch(
    products.map((product) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO shop_stock
           (product_slug, available, reserved, updated_at)
           VALUES (?, ?, 0, ?)`,
        )
        .bind(product.slug, product.stock, now),
    ),
  )
}

export async function cleanupExpiredReservations(db: D1Database) {
  const now = new Date().toISOString()
  const rows = await db
    .prepare(
      `SELECT id, product_slug, quantity
       FROM shop_stock_reservations
       WHERE status = 'active' AND expires_at <= ?
       LIMIT 100`,
    )
    .bind(now)
    .all<{ id: string; product_slug: string; quantity: number }>()

  for (const row of rows.results ?? []) {
    await releaseReservation(db, row.id, row.product_slug, row.quantity)
  }
}

async function releaseReservation(
  db: D1Database,
  id: string,
  productSlug: string,
  quantity: number,
) {
  const now = new Date().toISOString()
  await db.batch([
    db
      .prepare(
        `UPDATE shop_stock
         SET reserved = MAX(reserved - ?, 0), updated_at = ?
         WHERE product_slug = ?`,
      )
      .bind(quantity, now, productSlug),
    db
      .prepare(
        `UPDATE shop_stock_reservations
         SET status = 'released'
         WHERE id = ? AND status = 'active'`,
      )
      .bind(id),
  ])
}

export async function reserveStock(
  db: D1Database,
  orderId: string,
  items: ValidatedCartItem[],
) {
  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString()
  const reserved: {
    id: string
    productSlug: string
    quantity: number
  }[] = []

  for (const item of items) {
    const productSlug = item.product.slug
    const result = await db
      .prepare(
        `UPDATE shop_stock
         SET reserved = reserved + ?, updated_at = ?
         WHERE product_slug = ? AND available - reserved >= ?`,
      )
      .bind(item.quantity, createdAt, productSlug, item.quantity)
      .run()

    if (!result.meta?.changes) {
      for (const reservation of reserved) {
        await releaseReservation(
          db,
          reservation.id,
          reservation.productSlug,
          reservation.quantity,
        )
      }
      throw new ShopApiError(
        409,
        `${item.product.title}の在庫が不足しています。`,
      )
    }

    const reservationId = crypto.randomUUID()
    await db
      .prepare(
        `INSERT INTO shop_stock_reservations
         (id, order_id, product_slug, quantity, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(
        reservationId,
        orderId,
        productSlug,
        item.quantity,
        expiresAt,
        createdAt,
      )
      .run()

    reserved.push({ id: reservationId, productSlug, quantity: item.quantity })
  }
}

export async function releaseOrderReservations(
  db: D1Database,
  orderId: string,
) {
  const rows = await db
    .prepare(
      `SELECT id, product_slug, quantity
       FROM shop_stock_reservations
       WHERE order_id = ? AND status = 'active'`,
    )
    .bind(orderId)
    .all<{ id: string; product_slug: string; quantity: number }>()

  for (const row of rows.results ?? []) {
    await releaseReservation(db, row.id, row.product_slug, row.quantity)
  }
}

export async function consumeOrderReservations(
  db: D1Database,
  orderId: string,
) {
  const rows = await db
    .prepare(
      `SELECT id, product_slug, quantity
       FROM shop_stock_reservations
       WHERE order_id = ? AND status = 'active'`,
    )
    .bind(orderId)
    .all<{ id: string; product_slug: string; quantity: number }>()
  const now = new Date().toISOString()

  for (const row of rows.results ?? []) {
    await db.batch([
      db
        .prepare(
          `UPDATE shop_stock
           SET reserved = MAX(reserved - ?, 0),
               available = MAX(available - ?, 0),
               updated_at = ?
           WHERE product_slug = ?`,
        )
        .bind(row.quantity, row.quantity, now, row.product_slug),
      db
        .prepare(
          `UPDATE shop_stock_reservations
           SET status = 'consumed'
           WHERE id = ? AND status = 'active'`,
        )
        .bind(row.id),
    ])
  }
}

export async function createPendingOrder(
  db: D1Database,
  items: ValidatedCartItem[],
  shipping: ShippingQuote,
) {
  const orderId = crypto.randomUUID()
  const now = new Date().toISOString()
  const subtotal = getSubtotal(items)
  const total = subtotal + shipping.amountJpy

  await db
    .prepare(
      `INSERT INTO shop_orders
       (id, currency, subtotal_jpy, shipping_jpy, tax_jpy, total_jpy,
        payment_status, fulfillment_status, created_at, updated_at)
       VALUES (?, 'JPY', ?, ?, 0, ?, 'pending', 'pending', ?, ?)`,
    )
    .bind(orderId, subtotal, shipping.amountJpy, total, now, now)
    .run()

  await db.batch(
    items.map((item) =>
      db
        .prepare(
          `INSERT INTO shop_order_items
           (id, order_id, product_slug, title, category, fulfillment_type,
            quantity, unit_price_jpy, total_price_jpy, r2_object_key,
            shipping_profile_id, item_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .bind(
          crypto.randomUUID(),
          orderId,
          item.product.slug,
          item.product.title,
          item.product.category,
          item.product.fulfillmentType,
          item.quantity,
          item.product.priceJpy,
          item.lineTotalJpy,
          item.product.r2ObjectKey ?? null,
          item.product.shippingProfileId ?? null,
          now,
        ),
    ),
  )

  return orderId
}

export async function createStripeCheckoutSession(
  request: Request,
  env: ShopEnv,
  orderId: string,
  items: ValidatedCartItem[],
  shipping: ShippingQuote,
) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new ShopApiError(503, 'STRIPE_SECRET_KEYが未設定です。')
  }

  const origin = new URL(request.url).origin
  const params = new URLSearchParams()
  params.set('mode', 'payment')
  params.set('client_reference_id', orderId)
  params.set(
    'success_url',
    `${origin}/shop/checkout/success/?session_id={CHECKOUT_SESSION_ID}`,
  )
  params.set('cancel_url', `${origin}/shop/checkout/cancel/`)
  params.set('metadata[order_id]', orderId)
  params.set('payment_intent_data[metadata][order_id]', orderId)
  params.set(
    'automatic_tax[enabled]',
    settings.stripeTaxEnabled ? 'true' : 'false',
  )

  if (shipping.required) {
    ;(settings.allowedCountries ?? ['JP']).forEach((country, index) => {
      params.set(
        `shipping_address_collection[allowed_countries][${index}]`,
        country,
      )
    })
    params.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount')
    params.set(
      'shipping_options[0][shipping_rate_data][fixed_amount][amount]',
      String(shipping.amountJpy),
    )
    params.set(
      'shipping_options[0][shipping_rate_data][fixed_amount][currency]',
      'jpy',
    )
    params.set(
      'shipping_options[0][shipping_rate_data][display_name]',
      shipping.profile?.label ?? '送料',
    )
  }

  items.forEach((item, index) => {
    const product = item.product
    params.set(`line_items[${index}][quantity]`, String(item.quantity))
    params.set(`line_items[${index}][price_data][currency]`, 'jpy')
    params.set(
      `line_items[${index}][price_data][unit_amount]`,
      String(product.priceJpy),
    )
    params.set(
      `line_items[${index}][price_data][product_data][name]`,
      product.title,
    )
    params.set(
      `line_items[${index}][price_data][product_data][description]`,
      product.summary,
    )
    params.set(
      `line_items[${index}][price_data][product_data][metadata][product_slug]`,
      product.slug,
    )
    params.set(`line_items[${index}][metadata][product_slug]`, product.slug)

    if (product.taxCode) {
      params.set(
        `line_items[${index}][price_data][product_data][tax_code]`,
        product.taxCode,
      )
    }

    const image = product.images?.[0]?.src
    if (image) {
      params.set(
        `line_items[${index}][price_data][product_data][images][0]`,
        image.startsWith('http') ? image : `${origin}${image}`,
      )
    }
  })

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2026-02-25.clover',
    },
    body: params,
  })
  const body = (await response.json().catch(() => null)) as {
    id?: string
    url?: string
    payment_intent?: string
    error?: { message?: string }
  } | null

  if (!response.ok || !body?.id || !body.url) {
    throw new ShopApiError(
      502,
      body?.error?.message ?? 'Stripe Checkout Sessionを作成できませんでした。',
    )
  }

  return body
}

export async function recordFulfillmentEvent(
  db: D1Database,
  orderId: string,
  eventType: string,
  message: string,
  actor = 'system',
) {
  await db
    .prepare(
      `INSERT INTO shop_fulfillment_events
       (id, order_id, event_type, message, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      orderId,
      eventType,
      message,
      actor,
      new Date().toISOString(),
    )
    .run()
}

export async function getOrderBySession(db: D1Database, sessionId: string) {
  return db
    .prepare(
      `SELECT *
       FROM shop_orders
       WHERE stripe_checkout_session_id = ?
       LIMIT 1`,
    )
    .bind(sessionId)
    .first<OrderRow>()
}

export async function getOrderItems(db: D1Database, orderId: string) {
  const rows = await db
    .prepare(
      `SELECT *
       FROM shop_order_items
       WHERE order_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(orderId)
    .all<OrderItemRow>()
  return rows.results ?? []
}

export async function createDownloadToken(
  db: D1Database,
  env: ShopEnv,
  item: OrderItemRow,
) {
  if (!env.SHOP_DOWNLOAD_TOKEN_SECRET) {
    throw new ShopApiError(503, 'SHOP_DOWNLOAD_TOKEN_SECRETが未設定です。')
  }
  if (!item.r2_object_key) {
    throw new ShopApiError(503, '配布ファイルが未設定です。')
  }

  const token = `${crypto.randomUUID()}.${crypto.randomUUID()}`
  const tokenHash = await sha256Hex(
    `${env.SHOP_DOWNLOAD_TOKEN_SECRET}:${token}`,
  )
  const now = new Date()
  const expiresAt = new Date(now.getTime() + DOWNLOAD_TOKEN_TTL_SECONDS * 1000)

  await db
    .prepare(
      `INSERT INTO shop_download_tokens
       (token_hash, order_id, order_item_id, product_slug, r2_object_key,
        expires_at, max_uses, use_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 5, 0, ?)`,
    )
    .bind(
      tokenHash,
      item.order_id,
      item.id,
      item.product_slug,
      item.r2_object_key,
      expiresAt.toISOString(),
      now.toISOString(),
    )
    .run()

  return token
}

export async function hashDownloadToken(env: ShopEnv, token: string) {
  if (!env.SHOP_DOWNLOAD_TOKEN_SECRET) {
    throw new ShopApiError(503, 'SHOP_DOWNLOAD_TOKEN_SECRETが未設定です。')
  }
  return sha256Hex(`${env.SHOP_DOWNLOAD_TOKEN_SECRET}:${token}`)
}

export async function verifyStripeWebhook(request: Request, env: ShopEnv) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new ShopApiError(503, 'STRIPE_WEBHOOK_SECRETが未設定です。')
  }

  const payload = await request.text()
  const signatureHeader = request.headers.get('Stripe-Signature') || ''
  const timestamp = signatureHeader
    .split(',')
    .find((part) => part.startsWith('t='))
    ?.slice(2)
  const signature = signatureHeader
    .split(',')
    .find((part) => part.startsWith('v1='))
    ?.slice(3)

  if (!timestamp || !signature) {
    throw new ShopApiError(400, 'Stripe署名がありません。')
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    throw new ShopApiError(400, 'Stripe署名の時刻が無効です。')
  }

  const expected = await hmacHex(
    env.STRIPE_WEBHOOK_SECRET,
    `${timestamp}.${payload}`,
  )
  if (!constantTimeEqual(expected, signature)) {
    throw new ShopApiError(400, 'Stripe署名を検証できません。')
  }

  return JSON.parse(payload) as {
    id: string
    type: string
    data: { object: Record<string, unknown> }
  }
}

export async function beginStripeEvent(
  db: D1Database,
  eventId: string,
  eventType: string,
) {
  const now = new Date().toISOString()

  try {
    await db
      .prepare(
        `INSERT INTO stripe_events
         (event_id, event_type, processing_status, received_at)
         VALUES (?, ?, 'processing', ?)`,
      )
      .bind(eventId, eventType, now)
      .run()
    return true
  } catch {
    const existing = await db
      .prepare('SELECT processing_status FROM stripe_events WHERE event_id = ?')
      .bind(eventId)
      .first<{ processing_status: string }>()

    if (existing?.processing_status === 'processed') return false

    await db
      .prepare(
        `UPDATE stripe_events
         SET processing_status = 'processing', received_at = ?, error_message = NULL
         WHERE event_id = ?`,
      )
      .bind(now, eventId)
      .run()
    return true
  }
}

export async function finishStripeEvent(
  db: D1Database,
  eventId: string,
  status: 'processed' | 'failed',
  errorMessage?: string,
) {
  await db
    .prepare(
      `UPDATE stripe_events
       SET processing_status = ?, processed_at = ?, error_message = ?
       WHERE event_id = ?`,
    )
    .bind(status, new Date().toISOString(), errorMessage ?? null, eventId)
    .run()
}

export async function requireAdmin(request: Request, env: ShopEnv) {
  const session = getCookie(request, ADMIN_COOKIE)
  if (!session) throw new ShopApiError(401, '管理者ログインが必要です。')
  if (!(await verifyAdminSession(session, env))) {
    throw new ShopApiError(401, '管理者ログインが必要です。')
  }
}

export async function verifyAdminPassword(password: string, env: ShopEnv) {
  const configured = env.SHOP_ADMIN_PASSWORD_HASH || ''
  if (!configured.startsWith('sha256:')) return false

  const actual = await sha256Hex(password)
  return constantTimeEqual(configured.slice('sha256:'.length), actual)
}

export async function createAdminSession(env: ShopEnv) {
  if (!env.SHOP_ADMIN_SESSION_SECRET) {
    throw new ShopApiError(503, 'SHOP_ADMIN_SESSION_SECRETが未設定です。')
  }

  const payload = base64UrlEncode(
    JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS,
    }),
  )
  const signature = await hmacHex(env.SHOP_ADMIN_SESSION_SECRET, payload)
  return `${payload}.${signature}`
}

export function adminSessionCookie(token: string) {
  return `${ADMIN_COOKIE}=${token}; Path=/; Max-Age=${ADMIN_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`
}

async function verifyAdminSession(token: string, env: ShopEnv) {
  if (!env.SHOP_ADMIN_SESSION_SECRET) return false

  const [payload, signature] = token.split('.')
  if (!payload || !signature) return false

  const expected = await hmacHex(env.SHOP_ADMIN_SESSION_SECRET, payload)
  if (!constantTimeEqual(expected, signature)) return false

  try {
    const decoded = JSON.parse(base64UrlDecode(payload)) as { exp?: number }
    return Number(decoded.exp || 0) > Date.now() / 1000
  } catch {
    return false
  }
}

function getCookie(request: Request, name: string) {
  return request.headers
    .get('Cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return toHex(new Uint8Array(digest))
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  )
  return toHex(new Uint8Array(signature))
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let result = 0
  for (let i = 0; i < left.length; i += 1) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }
  return result === 0
}

function base64UrlEncode(value: string) {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return atob(padded)
}
