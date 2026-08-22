/**
 * GitHub's alerts: a blockquote whose first line names a kind.
 *
 * ```markdown
 * > [!NOTE]
 * > Useful information that users should know.
 * ```
 *
 * Five kinds, always uppercase, always the blockquote's first line, never nested — that is the
 * whole specification, and it is somebody else's. Implementing it rather than inventing a callout
 * syntax is the point: these notes are read on github.com, where this already renders, and in
 * Typora, which also renders it.
 *
 * **Nothing here touches a file.** The syntax is ordinary CommonMark — a blockquote with an
 * unremarkable first line — and both engines were measured round-tripping one byte for byte before
 * any of this was written. An editor that failed to draw it would show a quote with `[!NOTE]` in
 * it, which is what every other markdown tool shows and is not a loss.
 */

export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const

export type AlertKind = typeof ALERT_KINDS[number]

/**
 * The marker, and only in the shape GitHub accepts.
 *
 * Uppercase, its own line, at the very start. `[!Note]` and `[!HINT]` are not alerts *there*, so
 * they are not alerts here either — matching the renderer these notes are published through is the
 * entire reason to use its extension instead of a nicer one.
 */
const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?=\n|$)/

/**
 * The kind this blockquote is, and how much of its text the marker takes.
 *
 * `text` is the blockquote's first paragraph, exactly as the document holds it — the caller has
 * already decided what "first" means in its own tree.
 */
export function alertAt(text: string): { kind: AlertKind; length: number } | null {
  const found = MARKER.exec(text)
  if (found === null) return null
  return { kind: found[1]!.toLowerCase() as AlertKind, length: found[0].length }
}
