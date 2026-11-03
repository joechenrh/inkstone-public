import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'

/**
 * The picture, while it is still going up.
 *
 * Until now a pasted screenshot produced nothing on the page: the bytes are re-encoded, hashed and
 * sent, and only when the host answers does anything appear in the note. On a slow connection with
 * a large screenshot that is several seconds of a document that looks like the paste did not work,
 * which is long enough to paste again. Typora shows the picture immediately, dimmed, with a word
 * in the middle of it; this is that.
 *
 * **It is a decoration, not a node.** The obvious implementation — insert the image node now with
 * `URL.createObjectURL(file)` and swap the address later — writes `![](blob:http://…/6f378a6a…)`
 * into the file if the note is saved in those few seconds, which is a link to a byte range in a
 * tab that has since closed. That is the exact bug `image-paste.ts` exists to avoid, and it would
 * come back through a different door. A decoration is drawn and never serialised: save while one
 * is on screen and the file has nothing extra in it, which is the property the test asserts.
 *
 * The position is mapped through every transaction, so the placeholder stays where the picture
 * will land however much is typed above it while the upload runs.
 */

const placeholders = new PluginKey<DecorationSet>('inkstoneUploadPlaceholder')

interface Add { add: { id: object; at: number; src: string } }
interface Remove { remove: { id: object } }

/** What is drawn: the picture itself, dimmed, with the word over the middle of it. */
function widget(src: string): HTMLElement {
  const host = document.createElement('span')
  host.className = 'ink-uploading'
  const image = document.createElement('img')
  image.src = src
  image.alt = ''
  host.append(image)
  const label = document.createElement('span')
  label.className = 'ink-uploading-label'
  label.textContent = 'Uploading…'
  host.append(label)
  return host
}

export const uploadPlaceholder = $prose(() => new Plugin<DecorationSet>({
  key: placeholders,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      // Mapped first, so the placeholder follows its position through anything typed above it.
      let next = set.map(tr.mapping, tr.doc)
      const action = tr.getMeta(placeholders) as Add | Remove | undefined
      if (action !== undefined && 'add' in action) {
        const { id, at, src } = action.add
        next = next.add(tr.doc, [Decoration.widget(at, () => widget(src), { id })])
      }
      if (action !== undefined && 'remove' in action) {
        next = next.remove(next.find(undefined, undefined, (spec) => spec.id === action.remove.id))
      }
      return next
    },
  },
  props: {
    decorations: (state) => placeholders.getState(state),
  },
}))

/**
 * Show one, where the caret is. The returned function takes it away again.
 *
 * Called with the file rather than an address because the preview is the local bytes — there is no
 * address yet, which is the whole reason this exists. The object URL is revoked on the way out: a
 * blob kept alive is the picture held in memory for as long as the tab is open.
 */
export function showUploading(view: EditorView, file: File): () => void {
  const src = URL.createObjectURL(file)
  const id = {}
  const at = view.state.selection.from
  view.dispatch(view.state.tr.setMeta(placeholders, { add: { id, at, src } } satisfies Add))
  let gone = false
  return () => {
    if (gone) return
    gone = true
    URL.revokeObjectURL(src)
    view.dispatch(view.state.tr.setMeta(placeholders, { remove: { id } } satisfies Remove))
  }
}
