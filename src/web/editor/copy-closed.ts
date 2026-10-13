import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { closeMarksOn, marksAreOpen } from './mark-reveal.js'
import { closeSourceOn, sourceIsOpen } from './source-reveal.js'

/**
 * What leaves on the clipboard is the closed form.
 *
 * Two plugins reveal syntax in the document itself: `mark-reveal.ts` puts `**aa**` there with the
 * asterisks wearing the bold, and `source-reveal.ts` puts a literal `[a](b)` there in place of the
 * link. Both are true text while they are open, so both used to be copied as text — bold came out
 * as `<strong>**aa**</strong>`, which pasted back as a bold run whose text was `**aa**` and
 * serialised as `****aa****`, and a link came out as the characters `[a](b)`, which pasted back as
 * those characters and not as a link. The first was reported; the second is the same bug.
 *
 * **One hook for both, because the editor only ever runs one.** `transformCopied` is read through
 * `someProp`, which stops at the first plugin that has it — and the caller's callback returns the
 * new slice, which is always truthy. A second `transformCopied` anywhere in the editor is therefore
 * dead code, and since `sourceReveal` is registered before `markReveal`, putting one in each would
 * have silently turned the mark fix off.
 *
 * The slice is not edited. The document is closed in a transaction nobody dispatches — exactly what
 * `closedMarkdown` does before a save — and the selection is mapped through it and cut out of the
 * result. So the clipboard is served by the same two functions as the file on disk, and a reveal
 * can change its spelling without this having to be taught about it.
 */
export const copyClosed = $prose((ctx) => new Plugin({
  props: {
    transformCopied(slice, view) {
      const { state } = view
      if (!marksAreOpen(state) && !sourceIsOpen(state)) return slice
      const { from, to } = state.selection
      let tr = state.tr
      tr = closeMarksOn(state, tr, ctx)
      tr = closeSourceOn(state, tr, ctx)
      // Inwards at both ends: a selection that starts or ends inside the syntax has nothing left to
      // point at once the syntax is gone, and should land on the text rather than beside it.
      const from_ = tr.mapping.map(from, 1)
      const to_ = tr.mapping.map(to, -1)
      // A selection of nothing but syntax. Rare, and the raw characters are the honest answer.
      if (to_ <= from_) return slice
      return tr.doc.slice(from_, to_)
    },
  },
}))
