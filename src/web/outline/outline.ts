import { blockText } from '../editor/surface.js'
export interface OutlineItem {
  /** 1-6, taken from the heading's tag name. */
  level: number
  /** The heading text with Vditor's "## " marker removed. */
  text: string
  /**
   * The live heading element. Held instead of an id: Vditor derives heading ids from
   * the heading text, so an id changes the moment the heading is edited.
   */
  el: HTMLElement
}

const HEADING = /^H[1-6]$/

/**
 * Reads the outline out of the rendered document.
 *
 * Only one level down: in every engine the document's own headings are direct children of the
 * surface, and a heading nested inside a blockquote is not a section of the document.
 */
export function readOutline(root: HTMLElement | null): OutlineItem[] {
  if (!root) return []
  const items: OutlineItem[] = []
  for (const child of Array.from(root.children)) {
    if (!HEADING.test(child.tagName)) continue
    const el = child as HTMLElement
    items.push({ level: Number(el.tagName.charAt(1)), text: blockText(el), el })
  }
  return items
}


