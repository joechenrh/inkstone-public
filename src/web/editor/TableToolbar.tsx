import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { type Align, columnAlign, columnCount } from './tableOps.js'
import './table.css'

/** The grid you sweep to set the table's size. Bigger than anyone needs, small enough to fit. */
const GRID_ROWS = 8
const GRID_COLS = 8

export interface TableToolbarProps {
  table: HTMLTableElement
  /** Column the caret is in — the alignment buttons describe this one. */
  column: number
  /** Editor-relative position of the table, so the bar can sit in the band above it. */
  rect: { top: number; left: number; width: number }
  /** False while the document is scrolling — see the scroll handler in `VditorEditor`. */
  visible: boolean
  /**
   * What the bar wants done, rather than how to do it.
   *
   * It used to hand over a function that mutated the live table, which only one engine's document
   * *is*. Saying what is wanted lets each editor answer in its own terms — DOM surgery in one, a
   * transaction in the other — and keeps this file about the bar.
   *
   * `rows` counts the header, which is what the grid shows.
   */
  onAlign: (align: Align) => void
  onResize: (rows: number, cols: number) => void
  onDelete: () => void
}

const IconGrid = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
    <path d="M1.5 6h13M1.5 10.5h13M6 1.5v13M10.5 1.5v13" />
  </svg>
)

const IconAlign = ({ align }: { align: Align }) => {
  const middle = { left: 'M2 8h7', center: 'M4.5 8h7', right: 'M7 8h7' }[align]
  const last = { left: 'M2 12h10', center: 'M3 12h10', right: 'M4 12h10' }[align]
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
      <path d={`M2 4h12${middle}${last}`} />
    </svg>
  )
}

const IconTrash = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9M6.8 7v4.2M9.2 7v4.2" />
  </svg>
)

const ALIGNMENTS: Align[] = ['left', 'center', 'right']
const ALIGN_LABEL: Record<Align, string> = {
  left: 'Align column left',
  center: 'Align column centre',
  right: 'Align column right',
}

/**
 * The bar above a table, on Typora's model: it exists only while the caret is inside the table,
 * and the alignment buttons show the current column's state rather than only setting it.
 *
 * Rendered as an overlay in editor coordinates, never inside the editable surface — anything put
 * there becomes part of the document and would be serialised into the file.
 */
export function TableToolbar({ table, column, rect, visible, onAlign, onResize, onDelete }: TableToolbarProps) {
  const [sizeOpen, setSizeOpen] = useState(false)
  const [hover, setHover] = useState<{ rows: number; cols: number } | null>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const sizeBtnRef = useRef<HTMLButtonElement>(null)

  const rows = table.rows.length
  const cols = columnCount(table)
  const active = columnAlign(table, column)

  useLayoutEffect(() => {
    if (!sizeOpen) return
    const onPointerDown = (ev: MouseEvent) => {
      const t = ev.target as Node | null
      if (popRef.current?.contains(t) || sizeBtnRef.current?.contains(t)) return
      setSizeOpen(false)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      setSizeOpen(false)
      sizeBtnRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [sizeOpen])

  // The preview follows the pointer; with the pointer outside the grid it shows what is there now.
  const shown = hover ?? { rows, cols }

  return (
    <div
      class={`ink-table-bar${visible ? '' : ' away'}`}
      // Mounted either way so the fade has something to run on. It vanished and popped back
      // instantly before, which reads as a glitch rather than as a thing that stepped aside.
      aria-hidden={!visible}
      style={{ top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px` }}
      // The bar sits over the editor; a click in it must not move the caret out of the table,
      // which would unmount the bar before the button's own click ran.
      onMouseDown={(e) => { e.preventDefault() }}
    >
      <button
        ref={sizeBtnRef}
        type="button"
        class={`ink-table-btn${sizeOpen ? ' on' : ''}`}
        aria-label="Table size"
        aria-expanded={sizeOpen}
        onClick={() => { setSizeOpen((v) => !v) }}
      >
        <IconGrid />
      </button>

      <span class="ink-table-sep" />

      {ALIGNMENTS.map((align) => (
        <button
          key={align}
          type="button"
          class={`ink-table-btn${active === align ? ' on' : ''}`}
          aria-label={ALIGN_LABEL[align]}
          aria-pressed={active === align}
          onClick={() => { onAlign(align) }}
        >
          <IconAlign align={align} />
        </button>
      ))}

      <button
        type="button"
        class="ink-table-btn danger"
        aria-label="Delete table"
        onClick={() => { onDelete() }}
      >
        <IconTrash />
      </button>

      {sizeOpen && (
        <div ref={popRef} class="ink-table-size" role="dialog" aria-label="Table size">
          <div class="ink-table-grid" onMouseLeave={() => { setHover(null) }}>
            {Array.from({ length: GRID_ROWS }, (_, r) =>
              Array.from({ length: GRID_COLS }, (_, c) => (
                <button
                  key={`${r}-${c}`}
                  type="button"
                  class={`ink-table-cell${r < shown.rows && c < shown.cols ? ' sel' : ''}`}
                  aria-label={`${r + 1} by ${c + 1}`}
                  onMouseEnter={() => { setHover({ rows: r + 1, cols: c + 1 }) }}
                  onClick={() => {
                    onResize(r + 1, c + 1)
                    setSizeOpen(false)
                  }}
                />
              )))}
          </div>
          <div class="ink-table-size-label">{shown.rows} × {shown.cols}</div>
        </div>
      )}
    </div>
  )
}
