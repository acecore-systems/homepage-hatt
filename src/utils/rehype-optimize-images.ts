import { optimizeImage } from './image'

const IS_PROD = process.env.NODE_ENV === 'production'

type HastNode = {
  type?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function visitElements(node: HastNode, visitor: (node: HastNode) => void) {
  if (node.type === 'element') visitor(node)
  node.children?.forEach((child) => visitElements(child, visitor))
}

export default function rehypeOptimizeImages() {
  return (tree: HastNode) => {
    visitElements(tree, (node) => {
      if (node.tagName !== 'img') return

      node.properties ??= {}
      const src = node.properties.src
      if (typeof src === 'string') {
        const canOptimize =
          (src.startsWith('http') || src.startsWith('/')) &&
          !src.includes('/cdn-cgi/image/')
        if (IS_PROD && canOptimize) {
          node.properties.src = optimizeImage(src)
        }
      }

      node.properties.loading ??= 'lazy'
      node.properties.decoding ??= 'async'
      node.properties.width ??= 800
      node.properties.height ??= 450
    })
  }
}
