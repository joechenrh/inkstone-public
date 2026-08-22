/**
 * Turning whatever was on the clipboard into the bytes that go in the repository.
 *
 * Measured on three screenshots from this project, in a real browser: WebP at a longest edge of
 * 1600 and quality 0.82 comes to **4–6% of the source**. JPEG is three to four times worse on
 * screenshots, which are flat colour and hard edges. And re-encoding a PNG as a PNG is *larger than
 * the source every time* — 125% to 444% — because the canvas throws away whatever the original
 * encoder did.
 *
 * That last number is why this never re-encodes into the source format as a fallback. If WebP is
 * not available, or if the result is somehow bigger than what came in, the original bytes are kept
 * exactly as they are.
 *
 * It matters more here than in most applications: the repository keeps every version for ever, and
 * the server these notes are read from is on a pay-by-traffic line. A megabyte pasted once is a
 * megabyte served every time anyone opens that note.
 */

/** The longest edge anything is scaled down to. Nothing on a screen needs more. */
export const MAX_EDGE = 1600

/** WebP quality. High enough that text in a screenshot stays crisp. */
const QUALITY = 0.82

/** After re-encoding. Nothing real gets near this — it is here to stop a 200-megapixel scan. */
export const MAX_BYTES = 2 * 1024 * 1024

export interface EncodedImage {
  bytes: Uint8Array
  /** The MIME type of `bytes`, which is not necessarily the type that came in. */
  type: string
  /** The extension the file gets, without a dot. */
  ext: string
  width: number
  height: number
  /** What it was, so the reader can be told what happened to it. */
  from: number
  /** What it became. */
  to: number
}

export class ImageTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`still ${Math.round(bytes / 1024 / 1024)} MB after re-encoding`)
    this.name = 'ImageTooLarge'
  }
}

export class NotAnImage extends Error {
  constructor(readonly type: string) {
    super(`${type || 'that'} is not an image`)
    this.name = 'NotAnImage'
  }
}

const EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
}

/** Whether this is something a note can show at all. */
export function isImage(type: string): boolean {
  return type.startsWith('image/')
}

/**
 * The name a file gets: the first sixteen hex of the sha-256 of its own bytes.
 *
 * No name to invent and no collision to resolve — and pasting the same screenshot twice produces
 * the same name, so the second paste writes nothing. Deduplication falls out rather than being a
 * feature, and an immutable name is what makes the cache headers a fact rather than a hope.
 *
 * Sixteen and not eight, which is what the design said. Eight hex is four bytes, and by the
 * birthday bound ten thousand pictures collide about one time in eighty — and a collision here is
 * not a retry, it is the wrong picture in somebody's note, for ever, with no way to notice. Eight
 * more characters in a URL nobody reads is not a price. The server computes the same digest to the
 * same length, so both routes call the same picture the same thing.
 */
export async function hashName(bytes: Uint8Array, ext: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  const hex = Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `${hex}.${ext}`
}

/** Decode, so the size is known before anything is drawn. */
async function decode(blob: Blob): Promise<{ width: number; height: number; draw: CanvasImageSource }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    return { width: bitmap.width, height: bitmap.height, draw: bitmap }
  }
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => { resolve(el) }
      el.onerror = () => { reject(new Error('could not decode')) }
      el.src = url
    })
    return { width: img.naturalWidth, height: img.naturalHeight, draw: img }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * The image as it should be stored, or the original if that is already the better answer.
 *
 * An SVG is text and vector and is left alone entirely: rasterising one to 1600px would be the
 * opposite of what it is for.
 */
export async function encodeForNote(file: Blob): Promise<EncodedImage> {
  const type = file.type
  if (!isImage(type)) throw new NotAnImage(type)

  const original = new Uint8Array(await file.arrayBuffer())
  const keepAsIs = async (w: number, h: number): Promise<EncodedImage> => {
    if (original.byteLength > MAX_BYTES) throw new ImageTooLarge(original.byteLength)
    return {
      bytes: original, type, ext: EXT[type] ?? 'bin', width: w, height: h,
      from: original.byteLength, to: original.byteLength,
    }
  }

  if (type === 'image/svg+xml') return keepAsIs(0, 0)

  let source: { width: number; height: number; draw: CanvasImageSource }
  try {
    source = await decode(file)
  } catch {
    return keepAsIs(0, 0)
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(source.width, source.height))
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) return keepAsIs(source.width, source.height)
  ctx.drawImage(source.draw, 0, 0, width, height)

  const encoded = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/webp', QUALITY)
  })

  // No WebP, or it came out bigger than what was pasted — which happens with an image that was
  // already small and already well compressed. Either way the original is the better file.
  if (encoded === null || encoded.type !== 'image/webp' || encoded.size >= original.byteLength) {
    return keepAsIs(source.width, source.height)
  }
  if (encoded.size > MAX_BYTES) throw new ImageTooLarge(encoded.size)

  return {
    bytes: new Uint8Array(await encoded.arrayBuffer()),
    type: 'image/webp',
    ext: 'webp',
    width,
    height,
    from: original.byteLength,
    to: encoded.size,
  }
}

/** "581 KB → 35 KB", for the line under the picture. */
export function describeSaving(from: number, to: number): string {
  const kb = (n: number) => (n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`)
  return from === to ? kb(to) : `${kb(from)} → ${kb(to)}`
}
