/**
 * Where the document is, without naming whose editor it is.
 *
 * The outline, the search highlighter and the focus-ring exception each hardcoded
 * `.vditor-ir .vditor-reset` — three copies of one fact about a library we are replacing, in three
 * files that have nothing to do with editing. They ask here instead.
 *
 * `.ink-doc` is put on whichever element the mounted editor scrolls, so the answer is the same
 * shape for Vditor's `pre` and for ProseMirror's `div`.
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
 * Vditor keeps the literal `## ` in a marker span that is collapsed visually but still present in
 * `textContent`; ProseMirror shows no syntax at all, so the same call is simply the text. Cloning
 * rather than mutating, because the live node is the reader's document.
 */
export function blockText(el: HTMLElement): string {
  if (el.querySelector('.vditor-ir__marker') === null) return (el.textContent ?? '').trim()
  const clone = el.cloneNode(true) as HTMLElement
  for (const marker of Array.from(clone.querySelectorAll('.vditor-ir__marker'))) marker.remove()
  return (clone.textContent ?? '').trim()
}
