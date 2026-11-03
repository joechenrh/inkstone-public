import { $inputRule, $prose } from '@milkdown/kit/utils'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { linkSchema } from '@milkdown/kit/preset/commonmark'
import { parserCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { sourceRange } from './source-reveal.js'

/**
 * Typing a link, and pasting one.
 *
 * Crepe ships no input rule for `[text](url)`. Typed into the document it stays plain text, and
 * because it is plain text the serialiser has to protect it — so the note on disk gets `\[1\](2)`
 * and the link cannot be written at all without dropping into source mode and fixing it by hand.
 *
 * The bracket form becomes a link as the closing paren is typed. Pasting a URL assigns a link to
 * selected prose, replaces a selected existing link, or edits a field of revealed Markdown.
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
 * A URL pasted over selected prose links the text; a selected existing link is replaced.
 *
 * A plain ProseMirror plugin rather than `$pasteRule`, which matches a regex against the pasted
 * text and rewrites it — this needs the *selection*, which only `handlePaste` sees. It declines
 * when the clipboard is not a single URL according to the editor's parser. At an empty caret it
 * inserts a bare URL, ignoring a browser's accompanying HTML anchor. A Markdown fragment beginning
 * with a URL still belongs to the normal paste parser, not to this URL-assignment gesture.
 */
const URL_ONLY = /^(https?:\/\/\S+|mailto:\S+)$/

function singleUrl(ctx: Ctx, text: string): boolean {
  if (!URL_ONLY.test(text)) return false
  if (text.startsWith('mailto:')) return !/[\[\]()<>\\]/.test(text)
  // A string beginning with https:// can still contain several Markdown nodes. In particular,
  // URL[label](target) must go through the normal paste parser, never become one enormous href.
  try {
    const doc = ctx.get(parserCtx)(text)
    const paragraph = doc.firstChild
    const node = paragraph?.firstChild
    return doc.childCount === 1 && paragraph?.type.name === 'paragraph'
      && paragraph.childCount === 1 && node?.isText === true && node.text === text
      && node.marks.some((mark) => mark.type === linkSchema.type(ctx)
        && mark.attrs.syntax === 'bare' && mark.attrs.href === text)
  } catch { return false }
}

export const linkPasteRule = $prose((ctx) =>
  new Plugin({
    key: new PluginKey('inkstoneLinkPaste'),
    props: {
      // DOM events run before Milkdown's built-in handlePaste, which otherwise consumes HTML
      // anchors first and discards the fact that the clipboard contained just a URL.
      handleDOMEvents: { paste: (view, event) => {
        if (!view.editable) return false
        const text = event.clipboardData?.getData('text/plain')?.trim()
        if (!text || !singleUrl(ctx, text)) return false
        const { state } = view
        if (state.selection.$from.parent.type.spec.code
          || state.selection.$from.marks().some((mark) => mark.type.spec.code)) return false
        const type = linkSchema.type(ctx)
        const source = sourceRange(state)
        if (source && state.selection.from >= source.from && state.selection.to <= source.to
          && (state.selection.from > source.from || state.selection.to < source.to)) {
          event.preventDefault()
          view.dispatch(state.tr.insertText(text).removeStoredMark(type))
          return true
        }
        let replacesLink = source !== null
        state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
          if (node.marks.some((mark) => mark.type === type)) replacesLink = true
        })
        if (state.selection.empty || replacesLink) {
          if (!state.selection.$from.parent.type.allowsMarkType(type)) return false
          const mark = type.create({ href: text, title: '', syntax: 'bare' })
          event.preventDefault()
          view.dispatch(state.tr.replaceSelectionWith(state.schema.text(text, [mark]), false).removeStoredMark(type))
          return true
        }
        const mark = linkSchema.type(ctx).create({ href: text, title: '' })
        event.preventDefault()
        view.dispatch(state.tr.addMark(state.selection.from, state.selection.to, mark))
        return true
      } },
    },
  }),
)
