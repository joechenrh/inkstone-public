import { backend } from '../api/index.js'
import { cdnIsOn, uploadToHost } from './cdn.js'
import {
  describeSaving,
  encodeForNote,
  hashName,
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
  | {
    kind: 'kept'
    name: string
    count: number
    from: number
    to: number
    width: number
    height: number
    /** Whether it went to the picture host rather than into the vault. */
    onHost?: boolean
  }
  | { kind: 'linked'; name: string }
  /**
   * It went into the vault, and it was not supposed to.
   *
   * Not a refusal — the picture is safe and the note is whole. But saying nothing would leave the
   * reader believing it is on the picture host, and finding out otherwise months later, when the
   * repository has quietly grown by every screenshot since.
   */
  | { kind: 'fell-back'; why: string }
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
  /** Empty unless the picture host was asked and could not take it. */
  let fellBack = ''
  let onHost = false

  for (const [index, file] of files.entries()) {
    target.report({ kind: 'working', done: index, total: files.length })
    try {
      const image = await encodeForNote(file)

      /*
       * The picture host first, when there is one and the reader wants it.
       *
       * Falling back is the point rather than a safety net: a picture that could not be uploaded
       * still belongs in the note, and the vault is always there. So a failure here is not thrown —
       * it is a sentence to say afterwards, and the vault takes the bytes as it always did.
       */
      let hosted: string | null = null
      if (cdnIsOn()) {
        const named = await hashName(image.bytes, image.ext)
        const result = await uploadToHost(image.bytes, image.ext, named.slice(0, named.indexOf('.')))
        hosted = result.url
        if (result.url === null) fellBack = result.why
      }

      if (hosted !== null) {
        target.insert(`![](${hosted})`, hosted)
        name = hosted.slice(hosted.lastIndexOf('/') + 1)
        onHost = true
      } else {
        const { path, existed } = await backend.writeAsset(image.bytes, image.ext)
        target.insert(`![](/${path})`, path)
        name = path.slice(path.lastIndexOf('/') + 1)

        // The same picture, already here. Worth saying: something visible happened to the note and
        // nothing at all happened to the repository, and those look identical from the outside.
        if (existed && files.length === 1 && fellBack === '') {
          target.report({ kind: 'linked', name })
          return
        }
      }

      from += image.from
      to += image.to
      width = image.width
      height = image.height
    } catch (err) {
      target.report(refusal(err))
      return
    }
  }

  if (files.length === 0) return
  // The failure wins the line. Where the picture ended up is the thing that was not expected, and a
  // saving of 546 KB is not news beside it.
  if (fellBack !== '') {
    target.report({ kind: 'fell-back', why: fellBack })
    return
  }
  target.report({ kind: 'kept', name, count: files.length, from, to, width, height, onHost })
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
    case 'fell-back':
      // Where it went, then why it went there. The first half is what the reader has to know; the
      // second is what they would ask next.
      return { head: 'kept in the vault', detail: `the picture host could not take it · ${status.why}` }
    case 'refused':
      return { head: status.head, detail: status.detail }
    case 'kept': {
      const what = status.count > 1 ? `${status.count} pictures` : `${status.width}×${status.height}`
      const where = status.onHost === true ? ' · uploaded' : ''
      return { head: 'kept', detail: `${describeSaving(status.from, status.to)} · ${what}${where}` }
    }
  }
}
