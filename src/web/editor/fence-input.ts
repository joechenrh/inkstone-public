import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { codeBlockSchema, paragraphSchema } from '@milkdown/kit/preset/commonmark'
import type { Ctx } from '@milkdown/kit/ctx'

/**
 * ```` ```c++ ```` and Enter opens a fenced block in that language.
 *
 * The bare ```` ``` ```` already worked, through the rule the preset ships — but a fence with a
 * language did nothing at all, and a language is the normal case: the backticks were left as text,
 * and being text they came back from a save as ``\`\`\`c++``, escaped, so the note was worse for
 * having tried. Both forms go through here now, so there is one answer to "what does Enter do after
 * backticks" rather than two that disagree.
 *
 * The language is taken as written. `c++`, `objective-c` and `f#` are all real names and none of
 * them survives a stricter pattern.
 */

const KEY = new PluginKey('inkstoneFenceInput')

const FENCE = /^\s*(?:```|~~~)\s*([A-Za-z0-9+#._-]*)\s*$/

export const fenceInput = $prose((ctx: Ctx) =>
  new Plugin({
    key: KEY,
    props: {
      handleKeyDown(view, event) {
        if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey) return false
        const { state } = view
        const { $from, empty } = state.selection
        if (!empty || $from.parent.type !== paragraphSchema.type(ctx)) return false
        if ($from.parentOffset !== $from.parent.content.size) return false

        const match = FENCE.exec($from.parent.textContent)
        if (!match) return false

        const block = codeBlockSchema.type(ctx).create({ language: match[1] ?? '' })
        const from = $from.before()
        const tr = state.tr.replaceWith(from, $from.after(), block)
        tr.setSelection(TextSelection.create(tr.doc, Math.min(from + 1, tr.doc.content.size - 1)))
        view.dispatch(tr.scrollIntoView())
        return true
      },
    },
  }),
)
