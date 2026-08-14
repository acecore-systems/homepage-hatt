const legacyLucideClass = /^i-lucide-([a-z0-9-]+)$/

/**
 * Keeps CMS entries created before the Tailwind v4 migration rendering while
 * emitting the Iconify/Tailwind class convention used by all new content.
 */
export function normalizeIconClass(value?: string) {
  const iconClass = value?.trim()
  if (!iconClass) return undefined

  const legacyMatch = iconClass.match(legacyLucideClass)
  return legacyMatch ? `icon-[lucide--${legacyMatch[1]}]` : iconClass
}
