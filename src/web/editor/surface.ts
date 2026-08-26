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
 * Both engines put syntax in the block and both hide it from this: Vditor keeps the literal `## `
 * in a marker span that is collapsed visually but still present in `textContent`, and Crepe's
 * heading marker is a widget drawn in the gutter — `.ink-marker`, see `marker-reveal.ts`. The
 * second one was missed, so the moment the caret entered a heading the outline entry became
 * "## Title" and the anchor a `#heading` link resolves against changed with it. Reported as "the
 * outline picks the marker up too".
 *
 * Cloning rather than mutating, because the live node is the reader's document.
 */
const SYNTAX = '.vditor-ir__marker, .ink-marker'

export function blockText(el: HTMLElement): string {
  if (el.querySelector(SYNTAX) === null) return (el.textContent ?? '').trim()
  const clone = el.cloneNode(true) as HTMLElement
  for (const marker of Array.from(clone.querySelectorAll(SYNTAX))) marker.remove()
  return (clone.textContent ?? '').trim()
}
