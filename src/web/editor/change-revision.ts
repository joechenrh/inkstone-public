import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'

const key = new PluginKey<number>('inkstoneContentRevision')

/** Loading a note resets the counter; presentation-only transactions never advance it. */
export const changeRevision = $prose(() => new Plugin<number>({
  key,
  state: {
    init: () => 0,
    apply: (tr, value) => tr.docChanged && tr.getMeta('addToHistory') !== false ? value + 1 : value,
  },
}))

export const contentRevision = (state: EditorState): number => key.getState(state) ?? 0
