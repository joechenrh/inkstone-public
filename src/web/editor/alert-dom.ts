import { alertAt } from './alerts.js'
import './alerts.css'

/**
 * Alerts, for the surfaces whose document is a DOM: Vditor's editor and the shared reader page.
 *
 * The marker is a bare text node in both — `<blockquote><p>[!NOTE]\nUseful…` — so there is nothing
 * for CSS alone to take hold of, and something has to put a span around it.
 *
 * **Wrapping it does not reach the file**, which is the one thing worth measuring before writing a
 * line of this: Vditor's DOM *is* its markdown, and Lute serialises a plain span as the text inside
 * it. Measured on a real note — wrapped, edited elsewhere, saved, and the file still said
 * `> [!NOTE]`. The same experiment that unblocked pictures.
 *
 * Crepe does not use this. ProseMirror watches its own DOM and reads unexpected mutations back as
 * edits, so a stylist reaching into it can rewrite the document; that engine gets decorations
 * instead — `alert-reveal.ts`, same rules, same classes.
 */

/** Skipped while the caret is inside: see `sync`. */
const OPEN = 'ink-alert--open'

function markerOf(quote: Element): { text: Text; length: number } | null {
  const paragraph = quote.firstElementChild
  if (paragraph?.tagName !== 'P') return null
  // The first node, not the first text anywhere: the marker is the blockquote's first line or it
  // is not a marker at all.
  const first = paragraph.firstChild
  if (first === null || first.nodeType !== Node.TEXT_NODE) return null
  const found = alertAt(first.textContent ?? '')
  if (found === null) return null
  return { text: first as Text, length: found.length }
}

function kindOf(quote: Element): string | null {
  const paragraph = quote.firstElementChild
  if (paragraph?.tagName !== 'P') return null
  const wrapped = paragraph.firstElementChild
  const text = wrapped?.classList.contains('ink-alert-marker') === true
    ? `${wrapped.textContent ?? ''}${paragraph.childNodes[1]?.textContent ?? ''}`
    : paragraph.firstChild?.textContent ?? ''
  return alertAt(text)?.kind ?? null
}

/**
 * Put the span in, or leave what is there alone.
 *
 * Nothing is wrapped or unwrapped while the caret is in the blockquote. Wrapping would split a
 * text node the caret is standing in and move it; unwrapping would take the styling off the very
 * thing the reader came to look at — the first version did that, and the syntax showed in body
 * text in one engine and in coloured monospace in the other, for the same note.
 *
 * So the span is put in when the caret is elsewhere and simply stays. Editing the marker makes
 * Vditor re-render the paragraph and the span goes with it; that is fine, because by then the text
 * is being typed rather than read, and it comes back when the caret leaves.
 */
function sync(quote: Element, caretInside: boolean): void {
  const kind = kindOf(quote)
  if (kind === null) {
    quote.removeAttribute('data-alert')
    quote.classList.remove(OPEN)
    unwrap(quote)
    return
  }
  quote.setAttribute('data-alert', kind)
  quote.classList.toggle(OPEN, caretInside)
  if (!caretInside) wrap(quote)
}

function wrap(quote: Element): void {
  const paragraph = quote.firstElementChild
  if (paragraph === null) return
  if (paragraph.firstElementChild?.classList.contains('ink-alert-marker') === true) return
  const found = markerOf(quote)
  if (found === null) return

  const span = document.createElement('span')
  span.className = 'ink-alert-marker'
  // The line break goes in with it. Hidden on its own the marker would leave an empty first line,
  // because the break that followed it is still there.
  const rest = found.text.textContent ?? ''
  const eaten = rest.slice(0, found.length) + (rest[found.length] === '\n' ? '\n' : '')
  span.textContent = eaten
  found.text.textContent = rest.slice(eaten.length)
  paragraph.insertBefore(span, found.text)
}

function unwrap(quote: Element): void {
  const span = quote.querySelector(':scope > p > .ink-alert-marker')
  if (span === null) return
  const text = span.textContent ?? ''
  const next = span.nextSibling
  span.remove()
  if (next !== null && next.nodeType === Node.TEXT_NODE) next.textContent = text + (next.textContent ?? '')
  else quote.firstElementChild?.insertBefore(document.createTextNode(text), quote.firstElementChild.firstChild)
}

/**
 * Draw every alert in `root`, and keep drawing them, until the returned function is called.
 *
 * An observer rather than a pass: both surfaces re-render a blockquote freely — a keystroke in it,
 * a note arriving — and a one-shot decoration would survive neither.
 */
export function showAlerts(root: HTMLElement, options: { live?: boolean } = {}): () => void {
  const live = options.live ?? true
  let pending = 0

  const caretQuote = (): Element | null => {
    if (!live) return null
    const node = document.getSelection()?.anchorNode
    const el = node instanceof Element ? node : node?.parentElement
    const quote = el?.closest?.('blockquote')
    return quote !== undefined && quote !== null && root.contains(quote) ? quote : null
  }

  const pass = () => {
    pending = 0
    const open = caretQuote()
    for (const quote of Array.from(root.querySelectorAll('blockquote'))) {
      sync(quote, quote === open)
    }
  }

  const schedule = () => {
    if (pending !== 0) return
    pending = window.requestAnimationFrame(pass)
  }

  pass()
  // Our own wrapping is a childList change inside the tree being watched, so the pass has to be
  // idempotent — `wrap` returns early when the span is already there — and coalesced to a frame.
  const observer = new MutationObserver(schedule)
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  if (live) document.addEventListener('selectionchange', schedule)

  return () => {
    observer.disconnect()
    if (live) document.removeEventListener('selectionchange', schedule)
    if (pending !== 0) cancelAnimationFrame(pending)
  }
}
