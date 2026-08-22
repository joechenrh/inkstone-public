/**
 * Something for the mounted editor to do or to say, from somewhere that is not the editor.
 *
 * Two things use it. On a phone the clipboard is not the main way a picture comes in — it comes
 * from the library or the camera — so the button that offers those lives in the bottom bar, which
 * is nowhere near the editor. And following a link that leads nowhere has to be *said*, in the same
 * line that reports a paste, from code that has no view of its own.
 *
 * Deliberately one wire: exactly one editor is mounted, and it is the only thing that knows where
 * the caret is and where a line about it should go.
 *
 * Not a signal, because this is an event and not a state. A signal holding "the files being pasted"
 * would have to be cleared afterwards, and the moment it was not, mounting an editor would paste
 * whatever the last one had.
 */

export type EditorOffer =
  | { files: File[] }
  /**
   * Nothing came of it — an empty clipboard, a permission refused, a link to a note that is not
   * there. `head` is the verb, `detail` the number or name it was refused on.
   */
  | { notice: { head: string; detail: string } }

let handler: ((offer: EditorOffer) => void) | null = null

/** The mounted editor, saying it can take one. Returns the function that stops. */
export function receiveImages(fn: (offer: EditorOffer) => void): () => void {
  handler = fn
  return () => {
    if (handler === fn) handler = null
  }
}

/** Whether there is an editor to take one, which is what the phone's button asks before showing. */
export function canReceiveImages(): boolean {
  return handler !== null
}

export function offerImages(files: File[]): void {
  if (files.length > 0) handler?.({ files })
}

/** Say something in the line under the caret: `no such note · notes/deep/storage.md`. */
export function offerNotice(head: string, detail: string): void {
  handler?.({ notice: { head, detail } })
}
