import { backend } from '../api/index.js'

/**
 * Showing the pictures a note refers to, whichever editor rendered it.
 *
 * The markdown says `/assets/a1b2c3d4….webp`, which a browser resolves against the page — wrong in
 * both routes. Turning a path into something displayable is a fact about where the notes live, so
 * it is asked of the backend; this file is only the wire between the DOM and that question.
 *
 * One observer over the document rather than a hook in each engine, for the reason the whole of
 * last week taught: every rendering bug worth the name was a fact about the document written down
 * somewhere only one editor could read. An `<img>` is an `<img>` in both.
 *
 * Rewriting `src` in the document is safe: the editor has a real document model, so its DOM is a
 * rendering of the note and nothing is ever read back out of it. A picture whose `src` has been
 * pointed at a blob still saves the path the note was written with.
 */

/** Every picture a note refers to, in the order it refers to them. Used when a note is shared. */
export function assetsIn(markdown: string): string[] {
  const found = new Set<string>()
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(\s*<?(\/?assets\/[^)\s<>]+)>?/g)) {
    const path = assetPath(match[1] ?? '')
    if (path !== null) found.add(path)
  }
  return [...found]
}

/** The path a note refers to, or null if this `src` is not one. Both spellings, as markdown allows. */
function assetPath(src: string): string | null {
  const rel = src.startsWith('/') ? src.slice(1) : src
  if (!rel.startsWith('assets/')) return null
  // A resolved one comes back through the observer: `/api/asset?path=…` and `blob:…` are excluded
  // by the prefix, and this catches a path that already carries a query of its own.
  return rel.includes('?') ? null : decodeURIComponent(rel)
}

async function resolve(img: HTMLImageElement): Promise<void> {
  const path = assetPath(img.getAttribute('src') ?? '')
  if (path === null || img.dataset.inkAsset === path) return
  // Claimed before the await, so a second mutation in the same tick does not fetch it twice.
  img.dataset.inkAsset = path
  const url = await backend.assetUrl(path)
  // Still the same picture: the note may have been closed, or the path edited, while this waited.
  if (url !== null && img.dataset.inkAsset === path) img.src = url
}

function resolveWithin(node: Node): void {
  if (!(node instanceof Element)) return
  if (node instanceof HTMLImageElement) void resolve(node)
  node.querySelectorAll('img').forEach((img) => { void resolve(img) })
}

/**
 * Keep every picture in `root` pointed at something the browser can fetch, until the returned
 * function is called.
 *
 * The editor re-renders an image node freely — a caret entering it, a keystroke near it — so this
 * has to be an observer rather than a pass over the document. `data-ink-asset` is both the record
 * of what was resolved and the guard against the loop our own write would otherwise cause.
 */
export function showAssetImages(root: HTMLElement): () => void {
  resolveWithin(root)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') resolveWithin(record.target)
      else record.addedNodes.forEach(resolveWithin)
    }
  })
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  return () => { observer.disconnect() }
}
