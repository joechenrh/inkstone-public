import { MIRROR } from '../../shared/live-wire.js'
import type { LiveWire } from './provider.js'

/** How long after the last change the mirror catches up. The editor's own debounce, doubled. */
const SETTLE_MS = 400

/**
 * Keep the shared `Y.Text` in step with the note's markdown.
 *
 * This is the whole of how the server can answer an agent's read without a ProseMirror schema —
 * see `server/live/mirror.ts`, which is the other half.
 *
 * **One writer, which the caller guarantees.** The first version attached this in every client,
 * on the reasoning that they all hold the same document so they would all write the same text.
 * They do — and two clients each replacing the whole text concurrently is two insertions of it,
 * which a CRDT merges into the note twice over. Reported as every line appearing doubled while a
 * guest was in the room. Only the owner's editor writes this now.
 *
 * Debounced, because a keystroke is not worth a CRDT update of the whole note — and written once
 * immediately, because a session nobody is typing in should still be readable.
 */
export interface MirrorWriter {
  /** Write it now rather than on the timer — before answering an agent, so the answer is current. */
  flush: () => void
  stop: () => void
}

export function keepMirror(wire: LiveWire, read: () => string): MirrorWriter {
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
  return {
    flush: write,
    stop: () => {
      window.clearTimeout(timer)
      wire.doc.off('update', schedule)
    },
  }
}
