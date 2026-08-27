import { getCollection, getEntry, type CollectionEntry } from 'astro:content'

import { sortProducts, type ShopProduct, type ShopSettings } from './types'

export type ProductEntry = CollectionEntry<'products'>

export async function getShopProducts(
  options: { includeDraft?: boolean } = {},
) {
  const entries = await getCollection('products')
  const products = entries.map((entry) => entry.data as ShopProduct)
  const visibleProducts = options.includeDraft
    ? products
    : products.filter((product) => product.status !== 'draft')

  return sortProducts(visibleProducts)
}

export async function getShopProductBySlug(slug: string) {
  const products = await getShopProducts({ includeDraft: true })
  return products.find((product) => product.slug === slug)
}

export async function getShopSettings() {
  const settings = await getEntry('shopSettings', 'main')
  if (!settings) {
    throw new Error('Missing shop-settings/main.json')
  }
  return settings.data as ShopSettings
}
