import { $inputRule, $prose } from '@milkdown/kit/utils'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { linkSchema } from '@milkdown/kit/preset/commonmark'

/**
 * Typing a link, and pasting one.
 *
 * Crepe ships no input rule for `[text](url)`. Typed into the document it stays plain text, and
 * because it is plain text the serialiser has to protect it — so the note on disk gets `\[1\](2)`
 * and the link cannot be written at all without dropping into source mode and fixing it by hand.
 *
 * Both rules below are how every markdown editor behaves and how the other engine behaved: the
 * bracket form becomes a link as the closing paren is typed, and a URL pasted over a selection
 * wraps the selection rather than replacing it.
 */

/** `[text](url)` and `[text](url "title")`, completed by the closing paren. */
const LINK = /\[([^\]]+)\]\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)$/

export const linkInputRule = $inputRule((ctx) =>
  new InputRule(LINK, (state, match, start, end) => {
    const [, text, href, title] = match
    if (!text || !href) return null
    const type = linkSchema.type(ctx)
    const mark = type.create({ href, title: title ?? '' })
    return state.tr
      .replaceWith(start, end, state.schema.text(text, [mark]))
      // The caret ends up at the end of the new link and would otherwise carry its mark, so the
      // next thing typed joined it: `看 [9](8) 完` was saved as `看 [9 完](8)`, the link having
      // swallowed the words after it. Typing a link ends the link.
      .removeStoredMark(type)
  }),
)

/**
 * A URL pasted over selected text links the text, rather than replacing it.
 *
 * A plain ProseMirror plugin rather than `$pasteRule`, which matches a regex against the pasted
 * text and rewrites it — this needs the *selection*, which only `handlePaste` sees. It declines
 * unless something is selected, because pasting a URL at a bare caret should paste a URL.
 */
const URL_ONLY = /^(https?:\/\/\S+|mailto:\S+)$/

export const linkPasteRule = $prose((ctx) =>
  new Plugin({
    key: new PluginKey('inkstoneLinkPaste'),
    props: {
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData('text/plain')?.trim()
        if (!text || !URL_ONLY.test(text)) return false
        const { state } = view
        if (state.selection.empty) return false
        const mark = linkSchema.type(ctx).create({ href: text, title: '' })
        view.dispatch(state.tr.addMark(state.selection.from, state.selection.to, mark))
        return true
      },
    },
  }),
)
