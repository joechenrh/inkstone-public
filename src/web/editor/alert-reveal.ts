import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { blockquoteSchema } from '@milkdown/kit/preset/commonmark'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { Node } from '@milkdown/kit/prose/model'
import { alertAt } from './alerts.js'
import './alerts.css'

/**
 * Alerts in Crepe, as decorations.
 *
 * The other surfaces put a real span around the marker — see `alert-dom.ts` — and that is measured
 * safe there because Vditor's serialiser reads the text inside it. It would not be safe here:
 * ProseMirror watches its own DOM and reads unexpected mutations back as edits, so a stylist
 * reaching into it can rewrite the document. Decorations are not in the document at all, so there
 * is nothing to serialise and nothing to keep in step.
 *
 * The classes and every line of the CSS are shared with the DOM half. Only the act of attaching
 * differs, and it differs because the two engines are differently dangerous.
 *
 * Top-level blocks only: an alert "cannot be nested within other elements", which is GitHub's rule
 * and happens also to make this walk the document's children rather than the whole tree.
 */
export const alertReveal = $prose((ctx) =>
  new Plugin({
    key: new PluginKey('inkstoneAlertReveal'),
    props: {
      decorations(state: EditorState) {
        const quote = blockquoteSchema.type(ctx)
        const found: Decoration[] = []
        const { from: caretFrom, to: caretTo } = state.selection

        state.doc.forEach((node: Node, offset: number) => {
          if (node.type !== quote) return
          const paragraph = node.firstChild
          if (paragraph === null || !paragraph.isTextblock) return
          const alert = alertAt(paragraph.textContent)
          if (alert === null) return

          // The caret is *in* this one: the syntax shows, the label does not.
          const start = offset
          const end = offset + node.nodeSize
          const open = caretFrom < end && caretTo > start

          found.push(Decoration.node(start, end, {
            class: `ink-alert${open ? ' ink-alert--open' : ''}`,
            'data-alert': alert.kind,
          }))

          // The marker, and the break after it. Hiding the marker alone would leave the first line
          // empty, because the break that followed it is still there — and here it is a node of
          // its own rather than a character.
          const markerFrom = offset + 2
          let markerTo = markerFrom + alert.length
          const after = paragraph.maybeChild(1)
          if (paragraph.firstChild?.isText === true && after !== null && after?.isLeaf === true && !after.isText) {
            markerTo += after.nodeSize
          }
          found.push(Decoration.inline(markerFrom, markerTo, { class: 'ink-alert-marker' }))
        })

        return found.length === 0 ? null : DecorationSet.create(state.doc, found)
      },
    },
  }),
)
