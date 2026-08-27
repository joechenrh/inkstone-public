/**
 * Where the document is.
 *
 * The outline, the search highlighter and the focus-ring exception each hardcoded one fact about
 * the editor's own DOM, in three files that have nothing to do with editing. They ask here
 * instead, and `.ink-doc` is put on whatever the editor scrolls — including the reader's page,
 * which has no editor at all and is styled by the same themes.
 */

/** The class the mounted editor puts on its scroller. Also used by CSS. */
export const DOC_SURFACE = 'ink-doc'

/** The element the document scrolls in, or null when no editor is mounted. */
export function documentRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${DOC_SURFACE}`)
}

/**
 * The text of one rendered block, with any syntax the editor shows stripped out.
 *
 * The editor puts syntax in the block and hides it from this: a heading's `##` is a marker drawn
 * in the gutter — `.ink-marker`, see `marker-reveal.ts` — which is present in `textContent` and is
 * not part of the heading's name. Missing it meant the outline entry became "## Title" the moment
 * the caret entered a heading, and the anchor a `#heading` link resolves against moved with it.
 *
 * Cloning rather than mutating, because the live node is the reader's document.
 */
const SYNTAX = '.ink-marker'

export function blockText(el: HTMLElement): string {
  if (el.querySelector(SYNTAX) === null) return (el.textContent ?? '').trim()
  const clone = el.cloneNode(true) as HTMLElement
  for (const marker of Array.from(clone.querySelectorAll(SYNTAX))) marker.remove()
  return (clone.textContent ?? '').trim()
}
