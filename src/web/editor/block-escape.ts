import { TextSelection } from '@milkdown/kit/prose/state'
import { blockquoteSchema, codeBlockSchema, paragraphSchema } from '@milkdown/kit/preset/commonmark'
import { tableSchema } from '@milkdown/kit/preset/gfm'
import type { Ctx } from '@milkdown/kit/ctx'
import type { Node } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'

/**
 * Blocks with no room beside them.
 *
 * A code block and a table are both **walls**: they fill their own line, they hold their own
 * caret, and there is no position *between* two of them that an arrow key will ever reach. The
 * first version of this file fixed one pair — two fences — and the second added a second pair, two
 * tables, which was fixing a symptom twice. There are four pairs, and a wall at the start of a note
 * has the same problem with nothing at all beside it. It is one rule:
 *
 * > At the outer edge of a wall, if what is on that side is another wall or nothing, make a line.
 *
 * The reasons the caret cannot get there differ, and both were measured rather than assumed:
 *
 * - **Between two fences**, a gap cursor is refused *on purpose*. `GapCursor.valid` says no,
 *   because a `code_block` holds inline content and prosemirror-gapcursor reads that as "a caret
 *   can already go there". True of the node, false of this engine, which renders it as a CodeMirror
 *   behind a node view. Worse, the block's own escape runs `TextSelection.near(before, -1)`, which
 *   searches *backwards* and lands inside the previous fence — so Up walked into someone else's
 *   code and whatever was typed next went in there.
 * - **Between two tables**, a gap cursor *is* valid and nothing ever produces one: prosemirror-
 *   tables answers the arrow first and moves cell to cell, and the one it hands on has already left
 *   the table. From the first cell of the second table, Up lands in the last cell of the first.
 *
 * A navigation key writing to the document is worth being uneasy about, and it is what was asked
 * for: the paragraph is real, it is one undo step, and it only ever happens where the alternative
 * is silently landing in the wrong block.
 *
 * Caught in the capture phase, on the way down, because CodeMirror owns the key once it reaches its
 * own DOM — by then the selection has already moved.
 */

/** The two node types that leave nowhere to stand. */
function isWall(node: Node, ctx: Ctx): boolean {
  return node.type === codeBlockSchema.type(ctx) || node.type === tableSchema.type(ctx)
}

interface Wall {
  node: Node
  /** The position immediately before the wall. */
  before: number
}

/**
 * The wall the caret is in, but only when it is against the `dir` edge of it.
 *
 * Anywhere else the arrow key belongs to the block — to CodeMirror's own line movement, or to the
 * table's row movement — and taking it would break navigating inside them.
 */
function wallAtEdge(view: EditorView, ctx: Ctx, dir: -1 | 1, event: KeyboardEvent): Wall | null {
  return codeBlockAtEdge(view, ctx, dir, event)
    ?? tableAtEdge(view, ctx, dir)
    ?? quoteAtEdge(view, ctx, dir)
}

/**
 * A quote against the edge of the document.
 *
 * A quote is *not* a wall: its paragraphs hold an ordinary caret, so Up out of one lands in
 * whatever is above and Down out of one lands in whatever is below, both correctly. Only the
 * document's own edge is missing — a note that opens with a quote, which an alert is, had no way
 * to be given a line above it, reported as "cannot move up to make an empty line". That is the
 * whole of what this adds, and the neighbour test is here rather than in `isWall` on purpose:
 * calling a quote a wall would make Up from a fence *below* one open a line instead of stepping
 * into it, which is a position the caret can already reach.
 */
function quoteAtEdge(view: EditorView, ctx: Ctx, dir: -1 | 1): Wall | null {
  const type = blockquoteSchema.type(ctx)
  const { $from } = view.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type !== type) continue
    // Only the block against the edge; every other Up and Down moves within the quote.
    const index = $from.index(depth)
    if (dir < 0 ? index !== 0 : index !== node.childCount - 1) return null
    // And only on that block's own edge line: a paragraph in a quote can wrap.
    if (!view.endOfTextblock(dir < 0 ? 'up' : 'down')) return null
    const before = $from.before(depth)
    const outside = view.state.doc.resolve(dir < 0 ? before : before + node.nodeSize)
    if ((dir < 0 ? outside.nodeBefore : outside.nodeAfter) !== null) return null
    return { node, before }
  }
  return null
}

/**
 * A code block is asked through the DOM, because its caret is not ProseMirror's.
 *
 * The text lives in a CodeMirror instance behind a node view, so `state.selection` says only "in
 * the code block" — which line it is on is a fact only the DOM has.
 */
function codeBlockAtEdge(view: EditorView, ctx: Ctx, dir: -1 | 1, event: KeyboardEvent): Wall | null {
  const target = event.target as Element | null
  const block = target?.closest?.('.milkdown-code-block')
  if (!block) return null

  const selection = document.getSelection()
  const node = selection?.anchorNode
  const line = (node instanceof Element ? node : node?.parentElement)?.closest?.('.cm-line')
  if (!line) return null
  const edge = dir < 0 ? line.previousElementSibling === null : line.nextElementSibling === null
  if (!edge) return null

  let pos: number
  try {
    pos = view.posAtDOM(block, 0)
  } catch {
    return null
  }
  const $inside = view.state.doc.resolve(pos)
  if ($inside.depth === 0) return null
  const self = $inside.node($inside.depth)
  if (self.type !== codeBlockSchema.type(ctx)) return null
  return { node: self, before: $inside.before($inside.depth) }
}

/** A table is asked through the selection: its cells are ordinary textblocks. */
function tableAtEdge(view: EditorView, ctx: Ctx, dir: -1 | 1): Wall | null {
  const type = tableSchema.type(ctx)
  const { $from } = view.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type !== type) continue
    // Only the row against the wall; every other Up and Down moves between rows.
    const rowIndex = $from.index(depth)
    if (dir < 0 ? rowIndex !== 0 : rowIndex !== node.childCount - 1) return null
    // And only on the cell's own edge line: a cell can hold wrapped text.
    if (!view.endOfTextblock(dir < 0 ? 'up' : 'down')) return null
    return { node, before: $from.before(depth) }
  }
  return null
}

/**
 * Open a line beside a wall, when there is nowhere on that side to stand.
 *
 * Four pairs and two document edges, all from one predicate: fence–fence, fence–table,
 * table–fence, table–table, and a wall with nothing at all before or after it.
 */
export function openLineBesideWall(view: EditorView, ctx: Ctx, event: KeyboardEvent): boolean {
  const dir = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
  if (dir === 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false

  const wall = wallAtEdge(view, ctx, dir, event)
  if (wall === null) return false

  const at = view.state.doc.resolve(dir < 0 ? wall.before : wall.before + wall.node.nodeSize)
  const neighbour = dir < 0 ? at.nodeBefore : at.nodeAfter

  // Anything that is not a wall can already hold a caret, and ProseMirror's own handling is right:
  // a fence above a paragraph escapes into the paragraph, which always worked. `null` is the edge
  // of the document, where there is nothing to escape into at all.
  if (neighbour !== null && !isWall(neighbour, ctx)) return false

  event.preventDefault()
  event.stopPropagation()
  const paragraph = paragraphSchema.type(ctx).create()
  const tr = view.state.tr.insert(at.pos, paragraph)
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at.pos + 1)).scrollIntoView())
  view.focus()
  return true
}

/**
 * Backspace in an empty table takes the table away.
 *
 * Typora and the previous engine both do this, and it is the only way to delete a table without
 * knowing where its menu is: you empty it, and then the next Backspace — the one that would
 * otherwise do nothing at all, because there is nothing to the left of the first cell — removes
 * what is left. A table with anything in it is never deleted by a keystroke; that is the guard.
 */
export function deleteEmptyTable(view: EditorView, ctx: Ctx, event: KeyboardEvent): boolean {
  if (event.key !== 'Backspace' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false

  const type = tableSchema.type(ctx)
  const { $from, $to } = view.state.selection
  let depth = -1
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === type) { depth = d; break }
  }
  if (depth < 0) return false
  const table = $from.node(depth)

  /*
   * Nothing in any cell. `textContent` walks the whole node, which is what "empty" has to mean — a
   * table with one character in one cell is not one you meant to lose.
   *
   * This is also why the selection is not inspected beyond where it starts and ends. "The caret is
   * in the top-left cell" is not always a caret: clicking an *empty* cell selects something rather
   * than putting a caret in it — there is no text to put one in — and the first version tested for
   * `selection.empty` and so refused exactly the case it was written for. Inside an empty table
   * every selection selects nothing, so what kind it is does not matter.
   */
  if (table.textContent !== '') return false
  // …but it must not reach out of the table, where Backspace is deleting something real.
  if ($to.depth < depth || $to.before(depth) !== $from.before(depth)) return false

  /*
   * Any cell of it, not only the top-left one.
   *
   * The first version asked for the top-left cell, which is how the behaviour was described and is
   * a distinction the reader cannot make: an empty table is a grid of identical empty boxes, and
   * the first row of one with no header text in it looks exactly like the second. Reported as "this
   * table cannot be deleted" by someone whose caret was in the first *body* cell — where Backspace
   * did nothing at all, because there is nothing anywhere in an empty table to delete.
   *
   * That is the whole argument: `textContent` is empty, so no cell has anything Backspace could be
   * for, and there is nothing to lose whichever one it is pressed in.
   */

  event.preventDefault()
  event.stopPropagation()
  const before = $from.before(depth)
  const tr = view.state.tr.delete(before, before + table.nodeSize)
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(before, tr.doc.content.size)), -1))
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}

/**
 * Backspace in an empty line beside a wall takes the line, not the wall.
 *
 * The other half of `openLineBesideWall`: a line it made has to be as easy to take back, and it was
 * not. ProseMirror's own answer to Backspace in an empty paragraph after a table is `joinBackward`,
 * which cannot join a paragraph into a table and so *selects the table* instead — so the line stayed
 * where it was, the caret jumped into the grid, and the next Backspace, the one the reader pressed
 * because the first had done nothing they could see, deleted the whole table. Measured, in that
 * order. Reported as "it only moves into the table instead of deleting the empty line".
 */
export function deleteLineBesideWall(view: EditorView, ctx: Ctx, event: KeyboardEvent): boolean {
  if (event.key !== 'Backspace' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
  const { $from, empty } = view.state.selection
  if (!empty || $from.depth !== 1) return false

  const line = $from.parent
  // An empty line of its own: a paragraph with anything in it is being edited, and one nested in a
  // list or a quote has its own Backspace behaviour that works.
  if (line.type !== paragraphSchema.type(ctx) || line.content.size !== 0) return false

  const at = $from.before(1)
  const before = view.state.doc.resolve(at).nodeBefore
  if (before === null || !isWall(before, ctx)) return false

  event.preventDefault()
  event.stopPropagation()
  const tr = view.state.tr.delete(at, at + line.nodeSize)
  // Back where the line was made from: the last cell, or the end of the code.
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size)), -1))
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}
