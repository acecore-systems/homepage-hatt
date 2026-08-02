export type ShopCategory = 'picture' | 'novel' | 'modeling' | 'goods'
export type ShopStatus = 'draft' | 'published' | 'sold_out'
export type FulfillmentType = 'digital' | 'manual' | 'physical'
export type SellerAddressDisclosureMode = 'public' | 'on_request'

export type ShopImage = {
  src: string
  alt?: string
  caption?: string
}

export type ShopProduct = {
  slug: string
  title: string
  category: ShopCategory
  summary: string
  description?: string
  images: ShopImage[]
  priceJpy: number
  status: ShopStatus
  fulfillmentType: FulfillmentType
  stock: number
  maxQuantity: number
  r2ObjectKey?: string
  shippingProfileId?: string
  taxCode?: string
  externalUrl?: string
  features: string[]
  order: number
  featured: boolean
}

export type PublicShopProduct = Omit<ShopProduct, 'r2ObjectKey'>

export type ShippingProfile = {
  id: string
  label: string
  description?: string
  amountJpy: number
  freeAboveJpy?: number
  countries: string[]
}

export type ShopSettings = {
  id: string
  enabled: boolean
  checkoutEnabled: boolean
  currency: 'JPY'
  stripeTaxEnabled: boolean
  stripeConnectedAccountId?: string
  platformFeeBasisPoints: number
  platformFeeFixedJpy: number
  allowedCountries: string[]
  shippingProfiles: ShippingProfile[]
  businessName?: string
  sellerName?: string
  sellerAddress?: string
  sellerAddressDisclosureMode?: SellerAddressDisclosureMode
  sellerAddressDisclosureUrl?: string
  sellerAddressDisclosureProfileVersion?: string
  sellerPhone?: string
  sellerEmail?: string
  contactUrl?: string
  returnsPolicy?: string
  privacyPolicy?: string
  terms?: string
}

export type CartItemInput = {
  productId: string
  quantity: number
}

export const CATEGORY_LABELS: Record<ShopCategory, string> = {
  picture: '絵',
  novel: '小説',
  modeling: '3D作品',
  goods: 'グッズ',
}

export const FULFILLMENT_LABELS: Record<FulfillmentType, string> = {
  digital: 'デジタル配布',
  manual: '手動納品',
  physical: '物理発送',
}

export const STATUS_LABELS: Record<ShopStatus, string> = {
  draft: '下書き',
  published: '販売中',
  sold_out: '売り切れ',
}

export function formatJpy(amount: number) {
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: 'JPY',
    maximumFractionDigits: 0,
  }).format(amount)
}

export function toPublicProduct(product: ShopProduct): PublicShopProduct {
  const { r2ObjectKey, ...publicProduct } = product
  void r2ObjectKey
  return publicProduct
}

export function hasRequiredLegalFields(settings: ShopSettings) {
  return (
    [
      settings.businessName,
      settings.sellerName,
      settings.sellerPhone,
      settings.sellerEmail,
      settings.returnsPolicy,
      settings.privacyPolicy,
      settings.terms,
    ].every((value) => String(value || '').trim().length > 0) &&
    hasSellerAddressDisclosure(settings)
  )
}

export function hasSellerAddressDisclosure(settings: ShopSettings) {
  if (settings.sellerAddressDisclosureMode === 'on_request') {
    return (
      isShopRelativePath(settings.sellerAddressDisclosureUrl) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(
        String(settings.sellerAddressDisclosureProfileVersion || '').trim(),
      )
    )
  }

  return String(settings.sellerAddress || '').trim().length > 0
}

function isShopRelativePath(value: string | undefined) {
  const path = String(value || '').trim()
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')
}

export function hasRequiredStripeConnectFields(settings: ShopSettings) {
  return /^acct_[A-Za-z0-9]+$/.test(
    String(settings.stripeConnectedAccountId || '').trim(),
  )
}

export function canCheckout(settings: ShopSettings) {
  return (
    settings.enabled &&
    settings.checkoutEnabled &&
    hasRequiredLegalFields(settings) &&
    hasRequiredStripeConnectFields(settings)
  )
}

export function sortProducts<
  T extends Pick<ShopProduct, 'order' | 'title' | 'featured'>,
>(products: T[]) {
  return [...products].sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1
    return a.order - b.order || a.title.localeCompare(b.title, 'ja')
  })
}
