import { remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'

/**
 * The note is written the way it was typed — no backslashes, no character references.
 *
 * The serialiser protects any character that *could* begin something, so a note containing `[TODO]`
 * came back from a save as `\[TODO]` and one containing `**6**` as `\*\*6\*\*` — backslashes the
 * reader never typed, in a file they read in other places. The previous engine's serialiser does
 * not do this, and matching what the vault already looks like is the point.
 *
 * **The trade, stated plainly.** These escapes are not decoration: `\*\*6\*\*` is how a file says
 * "the characters, not bold", and dropping the backslashes means that note reads as bold the next
 * time it is opened. That is accepted here, because the escaped form is *also* how the file reads
 * everywhere else — github.com renders `\*\*6\*\*` as literal asterisks — and a reader who typed
 * `**6**` meant bold. Writing what they typed is the answer that agrees with every other tool that
 * opens the file. Someone who genuinely wants the characters can type the backslash themselves.
 *
 * **And the space at the end of a line.** A trailing space came back as `&#x20;`, which is the
 * serialiser being right and useless: markdown cannot hold a space at a line boundary, so it writes
 * a character reference to keep one. But nobody types a trailing space *on purpose* — it is what is
 * left behind after a word — and the cost of keeping it is an entity in the middle of a sentence,
 * in a file that is read on github.com and in other editors. Dropped, which is what the previous
 * engine's serialiser does and what makes the file stable: a literal space instead would be trailing
 * whitespace in git, and the next parse would drop it anyway and produce a diff nobody made.
 *
 * Only at the boundaries, which is the only place the encoder puts one — a `&#x20;` anywhere else
 * would be text somebody typed, and `&` on its own comes back as `&amp;`.
 *
 * Two things stay escaped, because for them the guess is not safe:
 *
 * - **A line-leading `* `**, which is a bullet. Unescaping it turns a paragraph into a list — a
 *   change of structure rather than of emphasis — so it is put back after the sweep.
 * - **Everything else**: `#` at the start of a line, `>`, `-`, `|`. Those make blocks, and a block
 *   appearing where a reader typed a character is a different order of wrong.
 */
export function writeWhatWasTyped(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, (options) => {
    const handlers = options.handlers ?? {}
    // Typed off the option it is going into, because `mdast-util-to-markdown` is a transitive
    // dependency whose types cannot be imported from here.
    const text: typeof handlers.text = (node, _parent, state, info) =>
      state.safe(String((node as { value?: unknown }).value ?? ''), info)
        // The brackets: markdown only treats them specially when a matching `](` or `][` follows,
        // and typing `[a](b)` here makes a link — so a literal that looks exactly like a link is
        // not something this application can produce by accident.
        .replace(/\\([[\]()])/g, '$1')
        // The inline emphasis characters.
        .replace(/\\([*~`])/g, '$1')
        // And the dollar sign, since maths was turned on. `$1$` typed in one go becomes a formula
        // and never reaches here; anything else — a lone `$`, a pair with the second one typed
        // somewhere other than at the end — was written to the file as `\$`, so a note that said
        // "costs $5" came back saying `costs \$5`. The cost of unescaping is that such a line is
        // read as maths the next time it is opened, here and on GitHub, which is what the file now
        // means: enabling maths made `$` punctuation. What it must not do is put a backslash in
        // front of a character someone typed.
        .replace(/\\(\$)/g, '$1')
        // …except the one that is a bullet rather than emphasis.
        .replace(/^(\s*)\* /gm, '$1\\* ')
        // The space at the end (or start) of a line, which markdown has no way to hold.
        .replace(/^(?:&#x(?:20|9);)+/i, '')
        .replace(/(?:&#x(?:20|9);)+$/i, '')
    return { ...options, handlers: { ...handlers, text } }
  })
}
