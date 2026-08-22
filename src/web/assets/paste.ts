import { backend } from '../api/index.js'
import {
  describeSaving,
  encodeForNote,
  ImageTooLarge,
  isImage,
  MAX_BYTES,
  NotAnImage,
} from './encode.js'

/**
 * Pasting a picture, in whichever editor is mounted.
 *
 * The pipeline is four steps and none of them belong to an engine: re-encode, hash, send, and put a
 * path in the note. What an editor contributes is one line — where the text goes — which is why this
 * takes an `insert` callback rather than knowing about a document model.
 *
 * The bytes leave the browser immediately. The instinct is to hold the image with the unsaved text
 * and write it out at save, and it cannot work: the uncommitted store is `localStorage`, which holds
 * strings in about five megabytes, and one screenshot would eat the budget the notes are living in.
 * It also turns out not to be wanted — an image is not something you edit, there is no version of it
 * that is half-typed, so there is nothing to keep pending.
 */

/** What the line under the picture is saying. Every state the design named has one of these. */
export type PasteStatus =
  | { kind: 'working'; done: number; total: number }
  | { kind: 'kept'; name: string; count: number; from: number; to: number; width: number; height: number }
  | { kind: 'linked'; name: string }
  | { kind: 'refused'; head: string; detail: string }

export interface PasteTarget {
  /** Put `![](path)` where the caret is. Called once per picture, as each one lands. */
  insert: (markdown: string, path: string) => void
  /** Every change of the line under the picture, ending in a settled state. */
  report: (status: PasteStatus) => void
}

/**
 * The images on a clipboard or a drop, and nothing else.
 *
 * A copy from a browser carries the picture *and* its HTML, and a paste of both would write the
 * markup as well. Text wins when there is text — copying a link that happens to have a favicon
 * should paste the link.
 */
export function imagesFrom(data: DataTransfer | null): File[] {
  if (data === null) return []
  const files = Array.from(data.files).filter((f) => isImage(f.type))
  if (files.length > 0) return files
  return Array.from(data.items)
    .filter((item) => item.kind === 'file' && isImage(item.type))
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null)
}

/** Whether a paste carries text that should win over any picture beside it. */
export function carriesText(data: DataTransfer | null): boolean {
  return (data?.getData('text/plain') ?? '') !== ''
}

const megabytes = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`

/**
 * Store each picture and insert it, reporting as it goes.
 *
 * Inserted one at a time rather than all at the end, so several files read as progress rather than
 * as a pause. A failure stops the run: the second picture of a pair failing after the first landed
 * would leave a note half-written with nothing saying which half.
 */
export async function storeImages(files: File[], target: PasteTarget): Promise<void> {
  let from = 0
  let to = 0
  let width = 0
  let height = 0
  let name = ''

  for (const [index, file] of files.entries()) {
    target.report({ kind: 'working', done: index, total: files.length })
    try {
      const image = await encodeForNote(file)
      const { path, existed } = await backend.writeAsset(image.bytes, image.ext)

      target.insert(`![](/${path})`, path)
      name = path.slice(path.lastIndexOf('/') + 1)
      from += image.from
      to += image.to
      width = image.width
      height = image.height

      // The same picture, already here. Worth saying: something visible happened to the note and
      // nothing at all happened to the repository, and those look identical from the outside.
      if (existed && files.length === 1) {
        target.report({ kind: 'linked', name })
        return
      }
    } catch (err) {
      target.report(refusal(err))
      return
    }
  }

  if (files.length === 0) return
  target.report({ kind: 'kept', name, count: files.length, from, to, width, height })
}

/**
 * Why it was not pasted, in the number it was refused on.
 *
 * "Too large" without the size is a wall. "14 MB after re-encoding · the ceiling is 2 MB" says it
 * was tried, what it came to, and roughly what would fit.
 */
function refusal(err: unknown): PasteStatus {
  if (err instanceof ImageTooLarge) {
    return {
      kind: 'refused',
      head: 'not pasted',
      detail: `${megabytes(err.bytes)} after re-encoding · the ceiling is ${megabytes(MAX_BYTES)}`,
    }
  }
  if (err instanceof NotAnImage) {
    return { kind: 'refused', head: 'not pasted', detail: `${err.type || 'that'} is not something a note can show` }
  }
  const why = err instanceof Error ? err.message : 'the upload failed'
  return { kind: 'refused', head: 'not pasted', detail: `${why} · try again` }
}

/** The line under the picture, as words. */
export function describeStatus(status: PasteStatus): { head: string; detail: string } {
  switch (status.kind) {
    case 'working':
      // What is happening, not what the code is called. "re-encoding" is the name of the step; the
      // reader wants to know their picture is being made smaller and that it has not finished.
      return status.total > 1
        ? { head: 'compressing', detail: `${status.done + 1} of ${status.total}…` }
        : { head: 'compressing', detail: 'the picture…' }
    case 'linked':
      return { head: 'linked', detail: 'the same picture is already here · nothing written' }
    case 'refused':
      return { head: status.head, detail: status.detail }
    case 'kept': {
      const what = status.count > 1 ? `${status.count} pictures` : `${status.width}×${status.height}`
      return { head: 'kept', detail: `${describeSaving(status.from, status.to)} · ${what}` }
    }
  }
}
