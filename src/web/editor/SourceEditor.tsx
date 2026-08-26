import { useLayoutEffect, useRef } from 'preact/hooks'
import { content, editContent } from '../state/document.js'
import { readOnly } from '../state/settings.js'
import { blockAtOffset, caretBlockIndex, lineAtOffset, offsetOfBlock, placeCaretInBlock } from './source-sync.js'
import { documentRoot } from './surface.js'
import './source.css'

/**
 * The raw markdown, for the edits the renderer is in the way of.
 *
 * A plain `<textarea>`, deliberately. Selection, undo, IME composition, find-in-page and every
 * accessibility affordance are the browser's to get right, and this is the one view whose whole
 * purpose is being trusted with the exact bytes — a hand-built editor would have to re-earn all of
 * it. The alternative that looked free, a highlighted layer behind a transparent textarea, needs
 * two elements to wrap and measure identically forever; one CJK line or one font fallback slides
 * the highlight off the text.
 *
 * Rendered over the editor column rather than instead of it, so VditorEditor stays mounted: it is
 * expensive to rebuild and it holds its own state. It does not re-render while this is open.
 */
export function SourceEditor() {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const text = content.value

  /*
   * Your place, on the way in and on the way back out.
   *
   * This used to open at character zero and return you to the top of the note, so in a long one the
   * cost of *looking* at the markdown was losing your place twice. Typora keeps it, and what is
   * kept here is the block: the fourth paragraph is the fourth paragraph in both views, which is
   * close enough to land you where you were and cannot drift into a wrong answer the way matching
   * offsets between a rendering and its source would. See `source-sync.ts`.
   *
   * The caret is not selected into: this mode is entered to change one thing, not to replace
   * everything.
   */
  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area) return

    const root = documentRoot()
    const from = root === null ? null : caretBlockIndex(root)
    const at = from === null ? 0 : offsetOfBlock(area.value, from)
    if (!readOnly.value) {
      area.focus()
      area.setSelectionRange(at, at)
    }
    // Focusing a textarea leaves it scrolled wherever the browser last had it — measured 346px
    // into a document whose caret was at character 0 — and a textarea has no "scroll to the
    // caret", so the line is put where a reader would expect to find it.
    const line = lineAtOffset(area.value, at)
    const height = parseFloat(getComputedStyle(area).lineHeight) || 24
    area.scrollTop = Math.max(0, line * height - area.clientHeight / 3)
    if (gutterRef.current) gutterRef.current.scrollTop = area.scrollTop

    return () => {
      // On the way back, from whatever the reader left the caret on — including a line they have
      // just typed, which is why the textarea's own value is read rather than the signal's.
      const back = blockAtOffset(area.value, area.selectionStart ?? 0)
      const surface = documentRoot()
      if (surface === null) return
      // After the mode has actually changed: this runs while the source is still on screen.
      requestAnimationFrame(() => {
        const live = documentRoot()
        if (live === null) return
        placeCaretInBlock(live, back)
        live.focus()
      })
    }
  }, [])

  // The gutter is a separate element, so it has to be scrolled by hand. Line numbers count
  // *lines*, not visual rows: a wrapped line is still one line, which is what a line number means
  // and what an error message would quote.
  const syncScroll = () => {
    if (gutterRef.current && areaRef.current) {
      gutterRef.current.scrollTop = areaRef.current.scrollTop
    }
  }

  const lines = text.split('\n')

  return (
    <div class="ink-source" role="region" aria-label="Markdown source">
      <div class="ink-source-gutter" ref={gutterRef} aria-hidden="true">
        {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <textarea
        ref={areaRef}
        class="ink-source-area"
        aria-label="Markdown source"
        spellcheck={false}
        readOnly={readOnly.value}
        value={text}
        onScroll={syncScroll}
        onInput={(e) => { editContent((e.target as HTMLTextAreaElement).value) }}
      />
    </div>
  )
}
