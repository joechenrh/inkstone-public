import { carriesText, imagesFrom } from '../assets/paste.js'

/**
 * Pictures arriving in Crepe, by paste or by drop.
 *
 * Crepe does have a hook for this, and it is the wrong one. Its `uploadConfig.uploader` is called
 * with the files and must answer with a `src` **string**; with no uploader configured it answers
 * `URL.createObjectURL(file)` — a note saved with `![](blob:http://…/6f378a6a…)`, which is a link to
 * a byte range in a tab that has since closed. Measured, not guessed: that is exactly what the first
 * paste into this editor wrote into the file.
 *
 * So the event is taken before ProseMirror sees it, in the capture phase on an ancestor of the
 * editable. Plugin order would not do it — the uploader is registered by Crepe's own builder, ahead
 * of anything added with `use()`, and the first handler to answer wins. This is the same shape as
 * the keydown interception in the other shell, and for the same reason.
 *
 * Text wins where there is text. A copy from a browser carries the picture *and* its HTML, and a
 * link with a favicon beside it should paste as the link.
 */
export function attachImagePaste(
  host: HTMLElement,
  onFiles: (files: File[], at: { x: number; y: number } | null) => void,
): () => void {
  const onPaste = (event: ClipboardEvent) => {
    if (carriesText(event.clipboardData)) return
    const files = imagesFrom(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    onFiles(files, null)
  }

  const onDrop = (event: DragEvent) => {
    const files = imagesFrom(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    // Where it was dropped, not where the caret was. A drop is a pointing gesture, and landing the
    // picture somewhere else makes it a gesture about nothing.
    onFiles(files, { x: event.clientX, y: event.clientY })
  }

  host.addEventListener('paste', onPaste, true)
  host.addEventListener('drop', onDrop, true)
  return () => {
    host.removeEventListener('paste', onPaste, true)
    host.removeEventListener('drop', onDrop, true)
  }
}
