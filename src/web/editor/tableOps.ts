/**
 * Table editing, done by rewriting the rendered table and telling Vditor the document changed.
 *
 * Three ways in were possible. Vditor's own `insertRow`/`deleteColumn`/`setTableAlign` are module
 * internals, not reachable from an instance, so a button cannot call them; synthesising the keydown
 * events it binds *would* reach them, but only two of the six survive — `⇧⌘=` and `⇧⌘-` never match,
 * and `setTableAlign` writes `style.textAlign`, which is not what the markdown is serialised from.
 * Rewriting the markdown ourselves would mean `setValue`, which rebuilds the document and drops the
 * caret.
 *
 * So: edit the DOM and dispatch `input`. Vditor serialises the table from the DOM through lute, and
 * the editor's own input handler carries it into `content` — measured end to end, from a row added
 * here to the row present in the file on disk. Nothing depends on a Vditor internal, and because
 * the document is never rebuilt, the caret stays where it was.
 *
 * Alignment lives in the `align` attribute of every cell in the column, which is what lute reads to
 * write the `:---:` delimiter row. Setting it on the header alone is not enough.
 */

export type Align = 'left' | 'center' | 'right'

/** Markdown tables always have a header row, so row 0 can never be removed. */
export const HEADER_ROWS = 1

export function tableFrom(node: Node | null | undefined): HTMLTableElement | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null
  return el?.closest('table') ?? null
}

export function cellFrom(node: Node | null | undefined): HTMLTableCellElement | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null
  return el?.closest('td, th') ?? null
}

/** Every row in document order — `table.rows` already spans thead and tbody. */
const rowsOf = (table: HTMLTableElement) => Array.from(table.rows)

export function columnCount(table: HTMLTableElement): number {
  return table.rows[0]?.cells.length ?? 0
}

export function columnAlign(table: HTMLTableElement, column: number): Align {
  const raw = table.rows[0]?.cells[column]?.getAttribute('align')
  return raw === 'center' || raw === 'right' ? raw : 'left'
}

export function setColumnAlign(table: HTMLTableElement, column: number, align: Align): void {
  for (const row of rowsOf(table)) {
    const cell = row.cells[column]
    // `left` is markdown's default, but it is written as `:---` rather than `---`, and being
    // explicit is what lets a column be aligned back to left after being centred.
    if (cell) cell.setAttribute('align', align)
  }
}

function newCell(table: HTMLTableElement, column: number, header: boolean): HTMLTableCellElement {
  const cell = document.createElement(header ? 'th' : 'td')
  cell.setAttribute('align', columnAlign(table, column))
  // A cell with no text at all collapses to nothing and cannot be clicked into. Vditor fills
  // empty cells with a zero-width space for the same reason.
  cell.textContent = '​'
  return cell
}

function newRow(table: HTMLTableElement): HTMLTableRowElement {
  const row = document.createElement('tr')
  for (let c = 0; c < columnCount(table); c++) row.appendChild(newCell(table, c, false))
  return row
}

/** `where` is relative to `rowIndex`. The header row can be inserted below but never above. */
export function insertRow(table: HTMLTableElement, rowIndex: number, where: 'above' | 'below'): void {
  const body = table.tBodies[0] ?? table.appendChild(document.createElement('tbody'))
  const row = newRow(table)
  const target = table.rows[rowIndex]

  if (rowIndex < HEADER_ROWS || where === 'below') {
    // Below the header means the top of the body, whichever section the caret was in.
    const after = rowIndex < HEADER_ROWS ? null : target?.nextElementSibling
    if (rowIndex < HEADER_ROWS) body.insertBefore(row, body.firstElementChild)
    else if (after && after.parentElement === body) body.insertBefore(row, after)
    else body.appendChild(row)
    return
  }
  body.insertBefore(row, target ?? null)
}

export function deleteRow(table: HTMLTableElement, rowIndex: number): void {
  if (rowIndex < HEADER_ROWS) return
  table.rows[rowIndex]?.remove()
}

export function insertColumn(table: HTMLTableElement, column: number, where: 'left' | 'right'): void {
  const at = where === 'left' ? column : column + 1
  for (const row of rowsOf(table)) {
    const header = row.parentElement?.tagName === 'THEAD'
    const cell = newCell(table, Math.min(column, columnCount(table) - 1), header)
    row.insertBefore(cell, row.cells[at] ?? null)
  }
}

export function deleteColumn(table: HTMLTableElement, column: number): void {
  // A table with no columns is not a table; the caller offers "delete table" for that.
  if (columnCount(table) <= 1) return
  for (const row of rowsOf(table)) row.cells[column]?.remove()
}

/**
 * Grow or shrink to `rows` x `cols`, counting the header as the first row.
 *
 * Only ever adds or removes at the end — which is why insert-in-the-middle is a separate
 * operation on the context menu rather than something the size grid could express.
 */
export function resize(table: HTMLTableElement, rows: number, cols: number): void {
  const wantRows = Math.max(HEADER_ROWS + 1, rows)
  const wantCols = Math.max(1, cols)

  while (columnCount(table) > wantCols) deleteColumn(table, columnCount(table) - 1)
  while (columnCount(table) < wantCols) insertColumn(table, columnCount(table) - 1, 'right')
  while (table.rows.length > wantRows) deleteRow(table, table.rows.length - 1)
  while (table.rows.length < wantRows) insertRow(table, table.rows.length - 1, 'below')
}

export function deleteTable(table: HTMLTableElement): void {
  table.remove()
}

/**
 * Tell Vditor the document changed.
 *
 * Its IR input handler is what re-serialises the DOM through lute and hands the markdown to our
 * own `input` callback, so without this a rewritten table is on screen but not in `content`, and
 * the next save would write the old text.
 */
export function notifyEdited(table: HTMLTableElement): void {
  const surface = table.closest('.vditor-ir')?.querySelector('pre.vditor-reset')
  surface?.dispatchEvent(new InputEvent('input', { bubbles: true }))
}

/** The cell the caret is in, or null when the selection is not inside a table. */
export function cellAtCaret(): { table: HTMLTableElement; cell: HTMLTableCellElement } | null {
  const anchor = document.getSelection()?.anchorNode
  const cell = cellFrom(anchor)
  const table = tableFrom(cell)
  return cell && table ? { table, cell } : null
}

/**
 * The next or previous cell in document order, wrapping across rows.
 *
 * Returns null at the two ends, which is what tells Tab in the last cell to add a row instead and
 * Shift+Tab in the first to do nothing.
 */
export function neighbourCell(
  table: HTMLTableElement,
  cell: HTMLTableCellElement,
  direction: 1 | -1,
): HTMLTableCellElement | null {
  const cells = rowsOf(table).flatMap((row) => Array.from(row.cells))
  const here = cells.indexOf(cell)
  if (here === -1) return null
  return cells[here + direction] ?? null
}

/** Put the caret at the end of a cell's text, which is where you want it when you Tab into one. */
export function focusCell(cell: HTMLTableCellElement): void {
  const range = document.createRange()
  range.selectNodeContents(cell)
  range.collapse(false)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}
