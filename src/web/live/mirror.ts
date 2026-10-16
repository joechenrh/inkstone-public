import { MIRROR } from '../../shared/live-wire.js'
import type { LiveWire } from './provider.js'

/** How long after the last change the mirror catches up. The editor's own debounce, doubled. */
const SETTLE_MS = 400

/**
 * Keep the shared `Y.Text` in step with the note's markdown.
 *
 * This is the whole of how the server can answer an agent's read without a ProseMirror schema —
 * see `server/live/mirror.ts`, which is the other half. Written by whoever is connected, which is a
 * race nobody loses: the text is replaced with what the document says, and every client's document
 * is the same document.
 *
 * Debounced, because a keystroke is not worth a CRDT update of the whole note — and written once
 * immediately, because a session nobody is typing in should still be readable.
 */
export function keepMirror(wire: LiveWire, read: () => string): () => void {
  const text = wire.doc.getText(MIRROR)
  let timer = 0

  const write = () => {
    const next = read()
    if (next === text.toString()) return
    // One transaction, so a reader never sees the note half-replaced.
    wire.doc.transact(() => {
      text.delete(0, text.length)
      text.insert(0, next)
    })
  }

  const schedule = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(write, SETTLE_MS)
  }

  wire.doc.on('update', schedule)
  write()
  return () => {
    window.clearTimeout(timer)
    wire.doc.off('update', schedule)
  }
}
