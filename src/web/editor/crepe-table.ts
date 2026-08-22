import { TextSelection } from '@milkdown/kit/prose/state'
import {
  tableCellSchema,
  tableHeaderRowSchema,
  tableHeaderSchema,
  tableRowSchema,
  tableSchema,
} from '@milkdown/kit/preset/gfm'
import { paragraphSchema } from '@milkdown/kit/preset/commonmark'
import type { Ctx } from '@milkdown/kit/ctx'
import type { Node } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Align } from './tableOps.js'

/**
 * The table bar's three operations, against a document model instead of a DOM.
 *
 * The bar itself is unchanged — it is the same component the other engine uses, and it still reads
 * the rendered `<table>` for the row and column counts and the current alignment, because both
 * engines render a real one. What changed is that it now says *what* it wants rather than reaching
 * into the table and doing it, which is the only part that was ever engine-shaped.
 *
 * Here that means transactions. Nothing walks the DOM, nothing has to be found again afterwards,
 * and the caret survives because ProseMirror maps it — all of which the other engine needs a page
 * of care for, because its table element is replaced on every edit.
 */

export interface TableTarget {
  /** Position of the table node in the document, for the transactions below. */
  pos: number
  node: Node
  /** The rendered table, which is what the bar measures and reads. */
  dom: HTMLTableElement
  /** Column the caret is in — the alignment buttons describe this one. */
  column: number
}

/** The table the caret is in, or null. */
export function tableAtCaret(view: EditorView, ctx: Ctx): TableTarget | null {
  const table = tableSchema.type(ctx)
  const { $from } = view.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type !== table) continue
    const pos = $from.before(depth)
    // The cell is two levels below the table: table > row > cell.
    const column = depth + 2 <= $from.depth ? $from.index(depth + 1) : 0
    const dom = view.nodeDOM(pos)
    // The first `table` in there is not necessarily the one on the page: this engine keeps a hidden
    // one as a drag preview, and taking it gave the bar a zero-sized box to sit on — measured at
    // `top: -48px; left: -260px; width: 0`, which is off the screen entirely.
    const el = dom instanceof HTMLElement
      ? (dom.matches('table') && dom.getBoundingClientRect().width > 0
          ? dom
          : Array.from(dom.querySelectorAll('table')).find((t) => t.getBoundingClientRect().width > 0) ?? null)
      : null
    if (!(el instanceof HTMLTableElement)) return null
    return { pos, node: $from.node(depth), dom: el, column }
  }
  return null
}

/**
 * Alignment belongs to the column, not to the cell.
 *
 * `setAlignCommand` in the preset sets the attribute on the *selected* cells, which for a caret is
 * one cell — and a markdown table has one alignment per column, written in the delimiter row. So
 * every cell in the column is set, which is what makes the file say what the button says.
 */
export function alignColumn(view: EditorView, target: TableTarget, align: Align): void {
  const { tr } = view.state
  let rowPos = target.pos + 1
  target.node.forEach((row) => {
    let cellPos = rowPos + 1
    row.forEach((cell, offset, index) => {
      if (index === target.column) {
        tr.setNodeMarkup(tr.mapping.map(cellPos), undefined, { ...cell.attrs, alignment: align })
      }
      cellPos += cell.nodeSize
    })
    rowPos += row.nodeSize
  })
  if (tr.docChanged) view.dispatch(tr)
}

export function deleteTable(view: EditorView, target: TableTarget): void {
  view.dispatch(view.state.tr.delete(target.pos, target.pos + target.node.nodeSize).scrollIntoView())
}

/**
 * Resize to exactly `rows` × `cols`, counting the header as the first row — which is what the grid
 * in the bar shows and what the other engine's version of this does.
 *
 * Rebuilt rather than grown a row at a time: the cells that exist keep their content and their
 * alignment, the rest are new, and one transaction means one undo step for one gesture.
 */
export function resizeTable(view: EditorView, ctx: Ctx, target: TableTarget, rows: number, cols: number): void {
  const schema = {
    table: tableSchema.type(ctx),
    headerRow: tableHeaderRowSchema.type(ctx),
    header: tableHeaderSchema.type(ctx),
    row: tableRowSchema.type(ctx),
    cell: tableCellSchema.type(ctx),
    paragraph: paragraphSchema.type(ctx),
  }
  const empty = () => schema.paragraph.create()
  const alignmentOf = (column: number) => {
    const first = target.node.firstChild
    return first?.child(Math.min(column, first.childCount - 1))?.attrs.alignment ?? null
  }

  const built: Node[] = []
  for (let r = 0; r < Math.max(1, rows); r++) {
    const existing = r < target.node.childCount ? target.node.child(r) : null
    const cells: Node[] = []
    for (let c = 0; c < Math.max(1, cols); c++) {
      const old = existing && c < existing.childCount ? existing.child(c) : null
      const type = r === 0 ? schema.header : schema.cell
      const attrs = { alignment: old?.attrs.alignment ?? alignmentOf(c) }
      cells.push(type.create(attrs, old ? old.content : empty()))
    }
    built.push((r === 0 ? schema.headerRow : schema.row).create(null, cells))
  }

  const next = schema.table.create(target.node.attrs, built)
  const tr = view.state.tr.replaceWith(target.pos, target.pos + target.node.nodeSize, next)
  // Into the first cell, which always exists whatever the new size is — the caret may have been in
  // a row or column that no longer does.
  const caret = Math.min(target.pos + 3, tr.doc.content.size - 1)
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView())
}
