import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import subsetFont from 'subset-font'

/**
 * A CJK face carrying only the characters one shared note actually uses.
 *
 * The reading page's whole promise is that a note reads exactly as it does in the editor, and for
 * Chinese that means shipping a serif — the app's own stack falls back to Songti SC otherwise, which
 * is a different typeface. The common subset the editor uses is 1.0MB and 1.1MB: fine for an app
 * someone opens daily and the browser caches for a year, and absurd for a link a stranger opens
 * once. Measured on a real note: **2,106KB of font for 181 distinct characters.**
 *
 * So the note gets its own. 181 characters is 48KB a weight, the glyphs are the same outlines, and
 * the reader waits for a tenth of a second instead of fifteen seconds on a 1Mbps line.
 *
 * The source is the **complete** face, kept in `assets/fonts/` and never served to a browser. That
 * costs 16MB in the image and nothing on the wire: the output holds only this note's characters, so
 * cutting from the whole face is the same size as cutting from the common subset — and it covers
 * the rare characters the common subset drops. Measured: five characters outside GB2312 level 1
 * come to 3.2KB from the full face and 0.8KB of nothing from the subset.
 *
 * If the full face is missing the shipped subset is used instead, which is the same rule the rest
 * of the app follows and simply loses those rare glyphs.
 */

/**
 * Exactly the range the shipped faces declare in `fonts.css`, and it must stay exactly that.
 *
 * The cut face carries only these characters and the shipped face *advertises* all of them, so a
 * character inside that range and outside this one is one the cut face lacks and the shipped one
 * claims — which fetches the megabyte this whole file exists to avoid. Fullwidth commas were
 * enough to do it on the first attempt.
 *
 * Holding only this range is also what keeps the reading page identical to the editor rather than
 * merely similar. The app's faces are confined to Chinese, so Latin in a heading falls through to
 * the system serif; a per-note face carrying Latin would quietly set those in Source Han Serif
 * instead. A face with no Latin glyphs cannot, whatever the CSS says.
 */
const CJK = /[\u2014\u2018-\u201D\u2026\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/

export type FontWeight = 'regular' | 'bold'
export const FONT_WEIGHTS: FontWeight[] = ['regular', 'bold']

/** Read once and kept: the same two megabytes would otherwise be re-read for every share. */
const sources = new Map<FontWeight, Promise<Buffer | null>>()

/**
 * Where the shipped faces are.
 *
 * `dist/web/assets` first, because Vite content-addresses them and that is what a built server has
 * beside it; `src` second, so `pnpm dev:server` works against the same files. Globbed rather than
 * named: the hash changes whenever the font does, which is the point of it.
 */
async function sourceFont(weight: FontWeight): Promise<Buffer | null> {
  const existing = sources.get(weight)
  if (existing !== undefined) return existing

  const found = (async () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const roots = [
      // The complete faces, server-side only. `dist/server/share` → repo root.
      path.resolve(here, '../../../assets/fonts'),
      path.resolve(here, '../../../../assets/fonts'),
      // Then whatever the browser is served, which is the common subset.
      path.resolve(here, '../../web/assets'),
      path.resolve(here, '../../../src/web/editor/fonts'),
    ]
    for (const root of roots) {
      let names: string[]
      try {
        names = await fs.readdir(root)
      } catch {
        continue
      }
      const name = names.find((n) =>
        n.startsWith(`source-han-serif-cn-${weight}`) && n.endsWith('.woff2'))
      if (name !== undefined) return fs.readFile(path.join(root, name))
    }
    return null
  })()

  sources.set(weight, found)
  return found
}

/**
 * The two faces a note needs, or null when it needs none.
 *
 * Null for a note with no Chinese in it, which is the common case in the Latin world and costs
 * those readers nothing at all — the same reasoning as the `unicode-range` in `fonts.css`.
 *
 * A failure here returns null rather than throwing: the reading page then falls back to the faces
 * the app ships, which is slower and completely correct. Sharing a note must not fail because a
 * font could not be cut.
 */
export async function subsetFor(text: string): Promise<Record<FontWeight, Buffer> | null> {
  if (!CJK.test(text)) return null

  const wanted = [...new Set(text)].filter((c) => CJK.test(c)).join('')
  try {
    const cut = await Promise.all(FONT_WEIGHTS.map(async (weight): Promise<Buffer | null> => {
      const source = await sourceFont(weight)
      if (source === null) return null
      return subsetFont(source, wanted, { targetFormat: 'woff2' })
    }))
    if (cut[0] == null || cut[1] == null) return null
    return { regular: cut[0], bold: cut[1] }
  } catch {
    return null
  }
}
