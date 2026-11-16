import { placeCaretInBlock } from './source-sync.js'

let pending: { path: string; block: number } | null = null

export function rememberSourceCaret(path: string, block: number): void {
  pending = { path, block }
}

/** Called after the rendered editor has applied the source text, which can rebuild its DOM. */
export function restoreSourceCaret(path: string | null, root: HTMLElement | null): void {
  const caret = pending
  pending = null
  if (!caret || caret.path !== path || !root) return
  placeCaretInBlock(root, caret.block)
  root.focus()
}
