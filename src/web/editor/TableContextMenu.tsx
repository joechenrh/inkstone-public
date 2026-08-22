import { useLayoutEffect, useRef } from 'preact/hooks'
import '../components/menu.css'
import {
  type Align,
  columnCount,
  deleteColumn,
  deleteRow,
  deleteTable,
  HEADER_ROWS,
  insertColumn,
  insertRow,
  setColumnAlign,
} from './tableOps.js'

export interface TableContextMenuProps {
  /** Where it was opened, in viewport coordinates. */
  at: { x: number; y: number }
  /** Cell the right-click landed in. */
  row: number
  column: number
  columns: number
  rows: number
  onApply: (
    mutate: (table: HTMLTableElement) => void,
    caretAfter?: (before: { row: number; column: number }) => { row: number; column: number },
  ) => void
  onClose: () => void
}

interface Item {
  label: string
  keys?: string
  danger?: boolean
  disabled?: boolean
  run: (table: HTMLTableElement) => void
  caretAfter?: (before: { row: number; column: number }) => { row: number; column: number }
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const KEY = (mac: string, other: string) => (isMac ? mac : other)

/**
 * Right-click inside a cell.
 *
 * This is where insert and delete live, because they act on a *position* — the row and column the
 * pointer landed in — and the bar's size grid can only grow and shrink from the end. Alignment
 * appears in both: the bar shows it as state, and the menu is where you would look for it.
 *
 * `position: fixed` from the pointer, like the file tree's menu: the editor scrolls, and an
 * absolutely positioned menu would be clipped by it.
 */
export function TableContextMenu(
  { at, row, column, columns, rows, onApply, onClose }: TableContextMenuProps,
) {
  const menuRef = useRef<HTMLDivElement>(null)

  const items: Item[] = [
    {
      label: 'Insert row above',
      keys: KEY('⇧⌘F', 'Ctrl+Shift+F'),
      // Above the header is still below it — markdown has no room above a header row.
      disabled: false,
      run: (t) => { insertRow(t, row, 'above') },
      caretAfter: (b) => ({ row: Math.max(HEADER_ROWS, b.row), column: b.column }),
    },
    {
      label: 'Insert row below',
      run: (t) => { insertRow(t, row, 'below') },
      caretAfter: (b) => ({ row: b.row + 1, column: b.column }),
    },
    {
      label: 'Insert column left',
      keys: KEY('⇧⌘G', 'Ctrl+Shift+G'),
      run: (t) => { insertColumn(t, column, 'left') },
      caretAfter: (b) => ({ row: b.row, column: b.column }),
    },
    {
      label: 'Insert column right',
      run: (t) => { insertColumn(t, column, 'right') },
      caretAfter: (b) => ({ row: b.row, column: b.column + 1 }),
    },
    ...(['left', 'center', 'right'] as Align[]).map((align) => ({
      label: `Align column ${align === 'center' ? 'centre' : align}`,
      run: (t: HTMLTableElement) => { setColumnAlign(t, column, align) },
    })),
    {
      label: 'Delete row',
      danger: true,
      // The header carries the column names and the alignment row; a markdown table without one
      // is not a table.
      disabled: row < HEADER_ROWS || rows <= HEADER_ROWS + 1,
      run: (t) => { deleteRow(t, row) },
      caretAfter: (b) => ({ row: Math.max(HEADER_ROWS, b.row - 1), column: b.column }),
    },
    {
      label: 'Delete column',
      danger: true,
      disabled: columns <= 1,
      run: (t) => { deleteColumn(t, column) },
      caretAfter: (b) => ({ row: b.row, column: Math.max(0, b.column - 1) }),
    },
    { label: 'Delete table', danger: true, run: deleteTable },
  ]

  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('.ink-menu-item:not([disabled])')?.focus()

    const onPointerDown = (ev: MouseEvent) => {
      if (menuRef.current?.contains(ev.target as Node)) return
      onClose()
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); onClose(); return }
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return
      ev.preventDefault()
      const buttons = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('.ink-menu-item:not([disabled])') ?? [],
      )
      if (!buttons.length) return
      const here = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const step = ev.key === 'ArrowDown' ? 1 : -1
      buttons[(here + step + buttons.length) % buttons.length]?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    // A fixed menu cannot follow the document, so a scroll closes it rather than letting it drift
    // away from the cell it describes.
    document.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={menuRef}
      class="ink-menu ink-table-menu"
      role="menu"
      aria-label="Table"
      tabIndex={-1}
      style={{ top: `${at.y}px`, left: `${at.x}px` }}
    >
      {items.map((item, i) => (
        <>
          {(i === 4 || i === 7) && <hr key={`sep-${i}`} class="ink-menu-sep" />}
          <button
            key={item.label}
            type="button"
            role="menuitem"
            class={`ink-menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onApply(item.run, item.caretAfter)
              onClose()
            }}
          >
            <span>{item.label}</span>
            {item.keys && <span class="ink-menu-keys">{item.keys}</span>}
          </button>
        </>
      ))}
    </div>
  )
}
