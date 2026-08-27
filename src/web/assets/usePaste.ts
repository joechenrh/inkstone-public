import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { RefObject } from 'preact'
import { documentRoot } from '../editor/surface.js'
import type { Point } from './inbox.js'
import { readOnly } from '../state/settings.js'
import { receiveImages } from './inbox.js'
import { storeImages, type PasteStatus } from './paste.js'

/**
 * The line under the picture, and what keeps it in the right place.
 *
 * It says what was done because something *was* done: the file in the repository is not the file
 * that was on the clipboard. Silently changing someone's image is not a thing to do quietly, and a
 * saving of 581 KB → 35 KB is worth a sentence. Then it goes away with the next keystroke, because
 * it is feedback and not a part of the note.
 *
 * Anchored to the picture it is about, in the same coordinates the table bar uses — an overlay in
 * `.ink-editor-stack`, which is not the scroll container. That is why scrolling dismisses it rather
 * than moving it: it cannot keep up, and a line hanging beside the wrong paragraph is worse than no
 * line at all.
 */

export interface PasteLine {
  status: PasteStatus
  /** Editor-relative, like the table bar's. The pill takes its own width from its text. */
  rect: { top: number; left: number }
}

/** Its own height plus the margin above it, from `paste.css`. */
const LINE_HEIGHT = 28

/**
 * How long to keep looking for the picture before settling for the caret.
 *
 * A picture is inserted, then rendered, then resolved to a URL the browser can fetch, then
 * *loaded* — and only then does it have a height to sit under. One frame is not enough, and it
 * showed: the pill measured against the caret and landed on top of the picture it was describing.
 * Half a second is long enough for a local read and short enough that a slow one is not followed
 * across the document.
 */
const ANCHOR_FRAMES = 30

/**
 * How long after appearing the pill ignores a scroll.
 *
 * Inserting a picture scrolls the document — one engine asks for it explicitly — so without this
 * the line is dismissed by the very event that put it there, and a paste with a tall screenshot
 * showed nothing at all.
 */
const SCROLL_GRACE_MS = 350

/**
 * How long a settled line stays when nothing else happens.
 *
 * "Gone with the next keystroke" is the right rule for a paste, because after a paste you carry on
 * typing. It is not a rule at all for a notice about a link that led nowhere: there is no next
 * keystroke, and `no such note` sat on the document until something else was clicked. Long enough
 * to read a path, short enough not to become furniture.
 *
 * A line that is still working never times out — it is replaced by the settled one, and vanishing
 * mid-encode would read as "finished".
 */
const LINGER_MS = 6000

export function useImagePaste(
  stackRef: RefObject<HTMLElement | null>,
  insert: (markdown: string, path: string) => void,
): { line: PasteLine | null; paste: (files: File[]) => void } {
  const [line, setLine] = useState<PasteLine | null>(null)
  const pathRef = useRef<string | null>(null)
  const insertRef = useRef(insert)
  insertRef.current = insert
  /**
   * Where the reader pressed, when the line is about a gesture rather than about a picture.
   *
   * A notice can be raised while reading, and reading has no caret; a phone reports a tap without
   * leaving a selection behind at all. Measured on a phone: without this the pill went to the
   * corner of the editor the first time, and beside a caret from some earlier edit after that.
   */
  const atRef = useRef<Point | null>(null)
  /** Bumped whenever this line stops being the current one, so a late frame cannot revive it. */
  const runRef = useRef(0)
  const placedAt = useRef(0)

  /**
   * Where the pill goes, and whether that is the answer or a stand-in.
   *
   * `settled` is false while the picture is not on screen yet: the caret is a reasonable guess in
   * the meantime, and a wrong guess left in place is what the last version shipped.
   */
  const anchor = useCallback((): { rect: PasteLine['rect']; settled: boolean } => {
    const stack = stackRef.current
    if (stack === null) return { rect: { top: 0, left: 0 }, settled: false }
    const box = stack.getBoundingClientRect()
    const path = pathRef.current

    // The *last* one, not the first. A picture already in the note is linked rather than written
    // again, so the same path can appear twice — and anchoring to the first put the line about what
    // just happened under a picture from further up the document.
    const matches = path === null
      ? []
      : stack.querySelectorAll<HTMLImageElement>(`img[data-ink-asset="${CSS.escape(path)}"]`)
    const img = matches.length === 0 ? null : matches[matches.length - 1]
    const drawn = img?.getBoundingClientRect()
    const settled = drawn !== undefined && drawn.height > 0
    const from = settled ? drawn : (pointRect(atRef.current) ?? caretRect())
    if (from === null || from === undefined) return { rect: { top: 0, left: 0 }, settled }

    /*
     * The line the caret is on, but the *column's* left edge.
     *
     * Before the picture exists there is only a caret to measure against, and a caret is wherever
     * the sentence happens to have reached — so the line appeared mid-paragraph, over the words,
     * and then jumped left to sit under the picture when it landed. Blocks start at the column's
     * left edge and so does a picture, so taking the left from the enclosing block puts it where it
     * is going to be and it stops moving sideways.
     */
    /*
     * A notice takes only its *height* from where the reader pressed. Starting it at the finger
     * would push a long path off the right edge, and there is no picture under it to line up with —
     * so it keeps the column's left edge, the same one a paste line uses.
     */
    const left = settled
      ? from.left
      : atRef.current !== null
        ? (blockLeftAt(atRef.current) ?? from.left)
        : (blockLeft() ?? from.left)

    // Under the picture, but never off the screen. A tall screenshot reaches past the bottom of the
    // window, and a line about what just happened is worth nothing where it cannot be read — so it
    // rides up over the picture rather than following it out of view.
    const view = documentRoot()?.getBoundingClientRect()
    const bottom = view?.bottom ?? window.innerHeight
    const top = Math.min(from.bottom, bottom - LINE_HEIGHT) - box.top
    return {
      rect: { top: Math.max(top, (view?.top ?? 0) - box.top), left: left - box.left },
      settled,
    }
  }, [stackRef])

  /** Show it, and keep re-measuring until the picture it is about has actually been drawn. */
  const place = useCallback((status: PasteStatus) => {
    const run = ++runRef.current
    placedAt.current = Date.now()
    let frames = 0
    const tick = () => {
      if (runRef.current !== run) return
      const { rect, settled } = anchor()
      setLine((was) => (was !== null && was.status === status && was.rect.top === rect.top
        && was.rect.left === rect.left
        ? was
        : { status, rect }))
      if (!settled && ++frames < ANCHOR_FRAMES) window.requestAnimationFrame(tick)
    }
    window.requestAnimationFrame(tick)
  }, [anchor])

  const paste = useCallback((files: File[]) => {
    if (files.length === 0 || readOnly.value) return
    pathRef.current = null
    atRef.current = null
    place({ kind: 'working', done: 0, total: files.length })
    void storeImages(files, {
      insert: (markdown, path) => {
        pathRef.current = path
        insertRef.current(markdown, path)
      },
      report: place,
    })
  }, [place])

  // The phone's picture button, which is nowhere near the editor. See `inbox.ts`.
  useEffect(() => receiveImages((offer) => {
    if ('files' in offer) { paste(offer.files); return }
    pathRef.current = null
    atRef.current = offer.notice.at
    place({ kind: 'refused', head: offer.notice.head, detail: offer.notice.detail })
  }), [paste, place])

  // The next keystroke, a click, or a scroll — each of them means the reader has moved on.
  useEffect(() => {
    if (line === null) return
    const dismiss = () => { runRef.current++; setLine(null) }
    const dismissOnScroll = () => {
      if (Date.now() - placedAt.current < SCROLL_GRACE_MS) return
      dismiss()
    }
    document.addEventListener('keydown', dismiss, true)
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('scroll', dismissOnScroll, true)
    const linger = line.status.kind === 'working' ? 0 : window.setTimeout(dismiss, LINGER_MS)
    return () => {
      document.removeEventListener('keydown', dismiss, true)
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('scroll', dismissOnScroll, true)
      window.clearTimeout(linger)
    }
  }, [line])

  return { line, paste }
}

/** The left edge of the block the caret is in — the content column's own edge, for block content. */
function blockLeft(): number | null {
  const node = document.getSelection()?.anchorNode
  const el = node instanceof Element ? node : node?.parentElement
  return leftOfBlock(el ?? null)
}

/** The same edge, for a line that is about something pressed rather than about the caret. */
function blockLeftAt(at: Point): number | null {
  return leftOfBlock(document.elementFromPoint(at.x, at.y))
}

function leftOfBlock(el: Element | null): number | null {
  const block = el?.closest?.('p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th')
  return block ? block.getBoundingClientRect().left : null
}

/** The pressed point as something with a bottom to hang the line under. */
function pointRect(at: Point | null): DOMRect | null {
  return at === null ? null : new DOMRect(at.x, at.y, 0, 0)
}

function caretRect(): DOMRect | null {
  const selection = document.getSelection()
  if (selection === null || selection.rangeCount === 0) return null
  const rect = selection.getRangeAt(0).getBoundingClientRect()
  // A collapsed range in an empty block measures zero everywhere; there is nothing to anchor to.
  return rect.top === 0 && rect.left === 0 ? null : rect
}
