import { backend } from '../api/index.js'
import { assetsIn } from '../assets/images.js'

/**
 * The pictures that have to travel with a shared note.
 *
 * A share is a copy — of the text, of the face cut to the text, and now of the pictures. The
 * alternative is a link back to where they live, and where they live is a private repository the
 * reader has no account for. So they are fetched here, through the same `assetUrl` the editor
 * shows them with, and sent with the note.
 *
 * A picture that cannot be fetched is left out rather than failing the share. The note will show
 * nothing where it was, which is what a note referring to a picture that was never stored should
 * do — and refusing to publish a page over one broken image would be the wrong trade.
 */
export async function assetsFor(markdown: string): Promise<{ name: string; bytes: string }[]> {
  const paths = assetsIn(markdown)
  const carried: { name: string; bytes: string }[] = []

  for (const path of paths) {
    try {
      const url = await backend.assetUrl(path)
      if (url === null) continue
      const res = await fetch(url)
      if (!res.ok) continue
      const bytes = new Uint8Array(await res.arrayBuffer())
      carried.push({ name: path.slice(path.lastIndexOf('/') + 1), bytes: toBase64(bytes) })
    } catch {
      continue
    }
  }
  return carried
}

/** Base64 in chunks, so a large picture cannot blow the argument stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}
