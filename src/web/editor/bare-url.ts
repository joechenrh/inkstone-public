import { linkSchema } from '@milkdown/kit/preset/commonmark'
import type { Ctx } from '@milkdown/kit/ctx'
import type { MarkSchema } from '@milkdown/kit/transformer'

/**
 * A URL written as a URL, not wrapped in link syntax.
 *
 * A note containing `https://example.com/a/b?c=1` came back from a save as
 * `<https://example.com/a/b?c=1>` — angle brackets the reader never typed, added to every bare URL
 * in the note merely by opening it. The same thing happens to a URL pasted in: it arrives as text,
 * the editor links it, and the file gets the bracketed form.
 *
 * That is the serialiser being correct and unhelpful, the same shape as the backslashes in
 * `markdown-escapes.ts`: `<url>` is how markdown writes a link whose text *is* its address, and
 * `mdast-util-to-markdown` has no reason to prefer one spelling over another. The file does. These
 * notes are read on github.com and in other editors, where a bare URL is already a link, and a
 * vault kept in git should not show a diff on a line nobody edited.
 *
 * So the mark is skipped on the way out when the text and the address are the same string — the
 * text node then carries the URL and is written as it stands. The mark stays in the *document*,
 * so the URL is still clickable while you are in the note, and GFM links it again on the next
 * open. Round trip: the same bytes.
 */

/**
 * Whether dropping the angle brackets round this URL is safe.
 *
 * Two things have to hold, and where either is in doubt the answer is no — the fallback is the
 * bracketed form, which is what the serialiser already writes.
 *
 * **It has to come back as the same link.** GFM's autolinking is not "any URL": it trims trailing
 * punctuation, it stops at an unbalanced `)`, and it ends an autolink at a character reference. A
 * URL that would come back shorter than it went out is a broken link in somebody's note.
 *
 * **It has to survive the text handler.** Written as text it goes through `writeWhatWasTyped`,
 * which unescapes `*`, `~`, `$`, brackets and parens — so a URL holding any of those could reparse
 * as emphasis, maths, or a link instead of as itself. Those characters are excluded rather than
 * reasoned about. `_` is allowed only between word characters, which is the one place the same
 * file leaves it unescaped, and `&` only where no character reference follows it.
 */
const SHAPE = /^https?:\/\/[A-Za-z0-9\-._:/?#@!&'+,;=%]+$/
const ENDS_WELL = /[A-Za-z0-9/]$/
const LOOSE_UNDERSCORE = /(?:^|[^\p{L}\p{N}_])_|_(?:$|[^\p{L}\p{N}_])/u
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/

export function keepsItsBareForm(url: string): boolean {
  return SHAPE.test(url)
    && ENDS_WELL.test(url)
    && !LOOSE_UNDERSCORE.test(url)
    && !ENTITY.test(url)
}

/** A link that is only its own address: `https://x` marked as a link to `https://x`, untitled. */
export function isBareUrl(text: string | null | undefined, href: unknown, title: unknown): boolean {
  if (typeof href !== 'string' || text !== href) return false
  if (title !== null && title !== undefined && title !== '') return false
  return /^https?:\/\/\S+$/i.test(href)
}

export const bareUrlsStayBare = linkSchema.extendSchema((prev) => (ctx: Ctx): MarkSchema => {
  const schema = prev(ctx)
  const upstream = schema.toMarkdown
  return {
    ...schema,
    toMarkdown: {
      match: upstream.match,
      runner: (state, mark, node) => {
        const text = (node as { text?: string | null }).text
        if (isBareUrl(text, mark.attrs.href, mark.attrs.title) && keepsItsBareForm(mark.attrs.href as string)) return
        upstream.runner(state, mark, node)
      },
    },
  }
})
