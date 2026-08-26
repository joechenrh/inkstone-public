import { setBlockType } from '@milkdown/kit/prose/commands'
import { headingSchema, paragraphSchema } from '@milkdown/kit/preset/commonmark'
import type { Ctx } from '@milkdown/kit/ctx'
import type { EditorView } from '@milkdown/kit/prose/view'

/**
 * A heading is made and unmade in one keystroke.
 *
 * Two things asked for, and they are the same idea from either end: a heading is a level, and the
 * key that names a level either gives you that level or takes it away.
 *
 * - **Backspace at the start of a heading removes it.** Milkdown's own binding demotes one level,
 *   so leaving a `###` took three presses and passed through two headings nobody wanted. What the
 *   `#`s mean together is "this is a heading", and Backspace against the front of a line is how
 *   markdown editors say "stop being one".
 * - **`Cmd+Opt+1`…`Cmd+Opt+6` set the level, and set it again to leave.** On a paragraph
 *   `Cmd+Opt+2` makes an `##`; on an `##` it makes a paragraph, which is the toggle every editor
 *   with these keys has. `Cmd+Opt+0` is the plain word for the same removal.
 *
 * **Why `Opt` is in there.** Chrome and Firefox on macOS take `Cmd+1`…`Cmd+9` for their own tab
 * switching before a page ever sees the event, which is why Notion and Google Docs both spell
 * these `Cmd+Opt+N`. In a browser the bare form cannot be had at all.
 *
 * **And why the key is read as `code`.** Holding Option on a Mac changes what a digit *types*:
 * `Opt+1` arrives as `¡` and `Opt+2` as `™`, so `event.key` is the wrong thing to compare. The
 * physical key is `event.code`, which says `Digit1` whatever the layout does with it.
 *
 * **Where it does nothing.** Inside a fenced block the keys belong to CodeMirror, which is a whole
 * editor with its own bindings and its own text; inside a table cell, a heading is not a thing the
 * schema allows. ProseMirror's own `setBlockType` refuses the second by itself, and the first has
 * to be declined here because this listener runs before CodeMirror sees the key at all.
 */

const DIGIT = /^(?:Digit|Numpad)([0-6])$/

/** The caret's own textblock, or null when it is somewhere a heading cannot be. */
function blockAt(view: EditorView, ctx: Ctx) {
  const { $from, empty } = view.state.selection
  if (!empty) return null
  const parent = $from.parent
  if (!parent.isTextblock || parent.type.spec.code === true) return null
  return parent
}

/** In a fenced block the keystroke is CodeMirror's, and it never reaches ProseMirror to be judged. */
function inCodeBlock(event: KeyboardEvent): boolean {
  const target = event.target as Element | null
  return target?.closest?.('.milkdown-code-block') != null
}

export function setHeadingLevel(view: EditorView, ctx: Ctx, event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey) return false
  const digit = DIGIT.exec(event.code)
  if (digit === null) return false
  if (inCodeBlock(event)) return false

  const block = blockAt(view, ctx)
  if (block === null) return false

  const heading = headingSchema.type(ctx)
  const level = Number(digit[1])
  // Already this heading: the same key takes it off, which is what every editor with these keys
  // does and what was asked for.
  const off = level === 0 || (block.type === heading && Number(block.attrs.level ?? 0) === level)
  const command = off
    ? setBlockType(paragraphSchema.type(ctx))
    : setBlockType(heading, { level })

  // Asked before claiming the key: in a table cell a heading is not allowed, and there the browser
  // and the application should both get their usual answer.
  if (!command(view.state, undefined, view)) return false
  event.preventDefault()
  event.stopPropagation()
  command(view.state, view.dispatch, view)
  view.focus()
  return true
}

export function unwrapHeadingOnBackspace(view: EditorView, ctx: Ctx, event: KeyboardEvent): boolean {
  if (event.key !== 'Backspace' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
  const { $from, empty } = view.state.selection
  if (!empty || $from.parentOffset !== 0) return false
  if ($from.parent.type !== headingSchema.type(ctx)) return false

  const command = setBlockType(paragraphSchema.type(ctx))
  if (!command(view.state, undefined, view)) return false
  event.preventDefault()
  event.stopPropagation()
  command(view.state, view.dispatch, view)
  view.focus()
  return true
}
