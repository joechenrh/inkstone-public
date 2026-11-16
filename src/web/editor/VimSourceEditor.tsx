import { useLayoutEffect, useRef } from 'preact/hooks'
import { Compartment, EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { vim, Vim } from '@replit/codemirror-vim'
import { content, editContent, flushSave, loadingPath } from '../state/document.js'
import { readOnly, sourceMode } from '../state/settings.js'
import { refreshGitStatus } from '../state/git.js'
import { blockAtOffset, caretBlockIndex, offsetOfBlock } from './source-sync.js'
import { rememberSourceCaret } from './source-return.js'
import { documentRoot } from './surface.js'
import { settingsOpen } from '../state/ui.js'
import { currentPath } from '../state/vault.js'

// Use the same save path as Cmd/Ctrl+S, including conflicts, errors and Git status.
Vim.defineEx('write', 'w', () => {
  void flushSave().then(() => { void refreshGitStatus() })
})

/** A real modal editor, only mounted when the source Vim preference is enabled. */
export function VimSourceEditor() {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const editable = useRef(new Compartment())
  const extensions = useRef<Extension[]>([])
  const text = content.value
  const locked = readOnly.value || loadingPath.value !== null

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const path = currentPath.value
    const root = documentRoot()
    const from = root === null ? null : caretBlockIndex(root)
    const at = from === null ? 0 : offsetOfBlock(content.value, from)
    extensions.current = [
      vim({ status: true }),
      history(),
      drawSelection(),
      lineNumbers(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown source', spellcheck: 'false' }),
      editable.current.of(EditorState.readOnly.of(locked)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const next = update.state.doc.toString()
          if (next !== content.peek()) editContent(next)
        }
      }),
    ]
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content.value,
        selection: { anchor: at },
        extensions: extensions.current,
      }),
    })
    viewRef.current = view
    if (!locked && !settingsOpen.peek()) view.focus()
    view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'center' }) })
    return () => {
      const back = blockAtOffset(view.state.doc.toString(), view.state.selection.main.head)
      viewRef.current = null
      view.destroy()
      if (path && !sourceMode.peek()) rememberSourceCaret(path, back)
    }
  }, [])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(locked)) })
    if (view.state.doc.toString() !== text) {
      // External reloads replace the state, so undo can never restore another file's text.
      const selection = Math.min(view.state.selection.main.head, text.length)
      view.setState(EditorState.create({
        doc: text,
        selection: { anchor: selection },
        extensions: extensions.current,
      }))
      view.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(locked)) })
    }
  }, [text, locked])

  return <div ref={hostRef} class="ink-source ink-source--vim" role="region" aria-label="Markdown source" />
}
