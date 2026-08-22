import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { paragraphSchema } from '@milkdown/kit/preset/commonmark'
import {
  tableCellSchema,
  tableHeaderRowSchema,
  tableHeaderSchema,
  tableRowSchema,
  tableSchema,
} from '@milkdown/kit/preset/gfm'
import type { Ctx } from '@milkdown/kit/ctx'
import type { Node } from '@milkdown/kit/prose/model'

/**
 * A row of pipes, and Enter, makes a table — the way Typora and the previous engine do it.
 *
 * Crepe ships an input rule of its own, but it takes a size: `|2x2|` gives you a 2×2 grid. Nobody
 * who writes markdown types that. They type the header row, because that is what a table *is* in
 * the file, and every editor that reads markdown turns it into a table when the row is finished.
 *
 * The header is what was typed and the body is one empty row, which is where the caret goes. The
 * alignment row is not asked for: it is the part of the syntax that exists for the parser rather
 * than the writer, and the table's own controls set alignment afterwards.
 */

const KEY = new PluginKey('inkstoneTableInput')

/** `| a | b |` — at least two cells, both pipes required, nothing but the row on the line. */
const ROW = /^\s*\|(.+\|)\s*$/

function cellsOf(line: string): string[] | null {
  const m = ROW.exec(line)
  if (!m?.[1]) return null
  // The trailing `|` closes the last cell rather than opening an empty one.
  const cells = m[1].slice(0, -1).split('|').map((c) => c.trim())
  if (cells.length < 2) return null
  // A separator row is not a table's first line — it is the line after it, and it means the reader
  // is typing the syntax out in full. Left alone, so nothing is taken over halfway through.
  if (cells.every((c) => /^:?-{1,}:?$/.test(c))) return null
  return cells
}

function buildTable(ctx: Ctx, cells: string[]): Node {
  const schema = {
    table: tableSchema.type(ctx),
    headerRow: tableHeaderRowSchema.type(ctx),
    header: tableHeaderSchema.type(ctx),
    row: tableRowSchema.type(ctx),
    cell: tableCellSchema.type(ctx),
    paragraph: paragraphSchema.type(ctx),
  }
  const text = (value: string) =>
    schema.paragraph.create(null, value ? schema.paragraph.schema.text(value) : null)
  const head = schema.headerRow.create(null, cells.map((c) => schema.header.create(null, text(c))))
  const body = schema.row.create(null, cells.map(() => schema.cell.create(null, text(''))))
  return schema.table.create(null, [head, body])
}

export const tableRowInput = $prose((ctx) =>
  new Plugin({
    key: KEY,
    props: {
      handleKeyDown(view, event) {
        if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey) return false
        const { state } = view
        const { $from, empty } = state.selection
        if (!empty || !$from.parent.isTextblock) return false
        // Only from a plain paragraph, and only with the caret at its end: mid-line Enter is a
        // split, and a pipe row inside a list item or a quote is that container's business.
        if ($from.parent.type !== paragraphSchema.type(ctx)) return false
        if ($from.parentOffset !== $from.parent.content.size) return false

        const cells = cellsOf($from.parent.textContent)
        if (!cells) return false

        const table = buildTable(ctx, cells)
        const from = $from.before()
        const tr = state.tr.replaceWith(from, $from.after(), table)
        // Into the first cell of the body row, which is where the next thing typed belongs.
        const pos = tr.doc.resolve(from + 1)
        const bodyStart = pos.pos + table.firstChild!.nodeSize + 2
        tr.setSelection(TextSelection.create(tr.doc, Math.min(bodyStart, tr.doc.content.size - 1)))
        view.dispatch(tr.scrollIntoView())
        return true
      },
    },
  }),
)
