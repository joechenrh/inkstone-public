import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { headingSchema } from '@milkdown/kit/preset/commonmark'
import type { EditorState } from '@milkdown/kit/prose/state'
import { readOnly } from '../state/settings.js'

/**
 * A heading's own `#`s, while the caret is in it.
 *
 * In the gutter rather than in the line — the column the previous engine floats them into — so the
 * words do not shift sideways when the caret arrives. That is also why this one is still a widget
 * when every other marker became text (see `mark-reveal.ts`): nothing is ever typed beside it and
 * no caret is ever next to it, because it is not in the line at all.
 */
function marker(syntax: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'ink-marker ink-marker--heading'
  span.textContent = syntax
  span.contentEditable = 'false'
  return span
}

export const markerReveal = $prose((ctx) =>
  new Plugin({
    key: new PluginKey('inkstoneMarkerReveal'),
    props: {
      decorations(state: EditorState) {
        // Read mode shows a note as it reads. Syntax is for the person writing it.
        if (readOnly.value) return null
        const { $head, empty } = state.selection
        if (!empty) return null

        const heading = headingSchema.type(ctx)
        for (let depth = $head.depth; depth > 0; depth--) {
          const node = $head.node(depth)
          if (node.type !== heading) continue
          const level = Number(node.attrs.level ?? 1)
          return DecorationSet.create(state.doc, [Decoration.widget(
            $head.start(depth),
            () => marker('#'.repeat(level)),
            { side: -1, key: `heading:${level}` },
          )])
        }
        return null
      },
    },
  }),
)
