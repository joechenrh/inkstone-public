// The face, Vditor's base and every document theme, in one list shared with the reader page.
import './document.css'
import './vditor-shell.css'
import { useEffect, useRef, useState } from 'preact/hooks'
import Vditor from 'vditor'
import { showAssetImages } from '../assets/images.js'
import { followLink } from './note-links.js'
import { showAlerts } from './alert-dom.js'
import { PasteLine } from '../assets/PasteLine.js'
import { useImagePaste } from '../assets/usePaste.js'
import { content, editContent } from '../state/document.js'
import { readOnly } from '../state/settings.js'
import { currentPath } from '../state/vault.js'
import { sourceMode } from '../state/settings.js'
import { resolvedTheme } from '../theme/useTheme.js'
import { DOC_SURFACE } from './surface.js'
import { TableToolbar } from './TableToolbar.js'
import { TableContextMenu } from './TableContextMenu.js'
import {
  cellAtCaret,
  cellFrom,
  columnCount,
  focusCell,
  insertColumn,
  insertRow,
  neighbourCell,
  notifyEdited,
  // The toolbar asks for these by name now rather than handing over a function that does them.
  deleteTable,
  resize,
  setColumnAlign,
  tableFrom,
} from './tableOps.js'

/** What the toolbar needs to draw itself: which table, which column, and where it is. */
interface TableTarget {
  table: HTMLTableElement
  column: number
  rect: { top: number; left: number; width: number }
}

/** How far above the table the bar sits — `margin-top: -26px` in `table.css`. */
const TABLE_BAR_HEIGHT = 26

/**
 * Quiet time before the table bar comes back after a scroll.
 *
 * Long enough that it does not flicker between the flicks of a trackpad fling, short enough that
 * it feels like it was waiting rather than fetched.
 */
const SCROLL_SETTLE_MS = 140

/** The one rendered block a selection covers exactly, if that is all it covers. */
function selectedBlock(range: Range, scroller: HTMLElement): HTMLElement | null {
  const { startContainer, startOffset, endContainer, endOffset } = range
  if (startContainer !== endContainer || startContainer !== scroller) return null
  if (endOffset - startOffset !== 1) return null
  const node = scroller.children[startOffset]
  return isRenderedBlock(node ?? null) ? node as HTMLElement : null
}

/**
 * A block Vditor renders rather than shows as text: code fences, maths, and the like.
 *
 * These carry a `vditor-ir__preview`, which is what makes them undeletable from the outside — the
 * caret walks past the rendered half and the browser deletes whatever it lands on next.
 */
function isRenderedBlock(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement
    && el.classList.contains('vditor-ir__node')
    && el.querySelector('.vditor-ir__preview') !== null
}

/**
 * Whether a collapsed caret sits at the very start or very end of a block's text.
 *
 * By what is on the other side of it, not by comparing boundary points. `(P, 0)` and `(#text, 0)`
 * are the same place to a reader and **not equal** to `compareBoundaryPoints` — a caret from a
 * click lands in the text node, so the comparison said "not at the start" for every real caret
 * there has ever been. It only agreed when a test put the caret on the element itself, which is
 * how this passed its first check while doing nothing in the editor.
 *
 * Zero-width spaces do not count as text: Vditor pads its IR markers with them, so a caret with
 * nothing but `\u200b` before it is at the start as far as anyone can see.
 */
function isAtEdge(range: Range, block: HTMLElement, edge: 'start' | 'end'): boolean {
  const side = document.createRange()
  side.selectNodeContents(block)
  if (edge === 'start') side.setEnd(range.startContainer, range.startOffset)
  else side.setStart(range.startContainer, range.startOffset)
  return side.toString().replace(/\u200b/g, '').length === 0
}

/**
 * Drop the undo entry `setValue` pushes for the document's arrival.
 *
 * Vditor adds it from `processAfterRender`, which runs after the render `setValue` triggers — so
 * clearing synchronously afterwards is not always enough. Cleared now and again on the next frame,
 * which covers both orderings without needing to know which one a given release uses.
 */
function clearUndoAfterRender(vd: { clearStack: () => void }): void {
  vd.clearStack()
  requestAnimationFrame(() => { vd.clearStack() })
}

/**
 * The IR mode's scroller, and it must be scoped this way.
 *
 * Vditor builds a `.vditor-reset` for every mode it knows — there are **four** inside the host, and
 * a bare `querySelector('.vditor-reset')` returns whichever comes first in the DOM, which is not
 * the one on screen. Its rect is empty, so anything measured against it silently answers zero.
 */
const IR_SCROLLER = '.vditor-ir .vditor-reset'

export function VditorEditor() {
  const hostRef = useRef<HTMLDivElement>(null)
  const stackRef = useRef<HTMLDivElement>(null)
  const [tableTarget, setTableTarget] = useState<TableTarget | null>(null)
  /** The bar is hidden while it would be drawn outside the text, not unmounted — see `tableBarFits`. */
  const [tableBarVisible, setTableBarVisible] = useState(true)
  const tableTargetRef = useRef<TableTarget | null>(null)
  tableTargetRef.current = tableTarget
  const [tableMenu, setTableMenu] = useState<
    { at: { x: number; y: number }; row: number; column: number; rows: number; columns: number } | null
  >(null)
  const vditorRef = useRef<Vditor | null>(null)
  const { line, paste } = useImagePaste(stackRef, (markdown) => {
    // `insertValue` renders it, which is what puts an `<img>` in the document for the resolver to
    // find and for the line below to be measured against.
    vditorRef.current?.insertValue(markdown, true)
  })
  const pasteRef = useRef(paste)
  pasteRef.current = paste
  const readyRef = useRef(false)
  const settingRef = useRef(false) // when true, the input callback does not feed back into editContent
  // The "last value the editor and content agreed on". Used both to filter the async
  // input echo triggered by setValue, and to decide whether a content change needs to be
  // pushed back into the editor — see the two comments below.
  const lastSyncedRef = useRef<string | null>(null)

  // Read as a ref so the capture listener below can be installed once and still see the
  // current mode; re-binding it on every toggle would race with Vditor's own listener.
  const readOnlyRef = useRef(readOnly.value)
  readOnlyRef.current = readOnly.value

  // Editable only with a file open and read-only mode off.
  //
  // vd.disabled() only sets contenteditable=false, which stops typing but NOT the rendering
  // changing under the pointer: Vditor's IR click handler calls expandMarker on whatever the
  // click landed in, so a click still swapped a rendered block for its ``` source. Measured:
  // one expanded node per click with the editor disabled. Collapsing anything already open is
  // part of the same job — entering read-only with a block expanded would strand it.
  function syncEditable(vd: Vditor): void {
    if (currentPath.value && !readOnly.value) {
      vd.enable()
      return
    }
    vd.disabled()
    hostRef.current
      ?.querySelectorAll('.vditor-ir__node--expand')
      .forEach((el) => { el.classList.remove('vditor-ir__node--expand') })
  }

  /**
   * Where the caret is, in table terms — recomputed on selection changes and after every table
   * edit, and null whenever the caret is outside a table or the document is read-only.
   *
   * The rect is measured against `.ink-editor-stack`, not the viewport: the bar is an overlay
   * inside that box, so it scrolls with the document instead of hanging in the air.
   */
  const syncTableTarget = () => {
    const host = hostRef.current
    if (!host || readOnlyRef.current) { setTableTarget(null); return }
    const at = cellAtCaret()
    if (!at || !host.contains(at.table)) { setTableTarget(null); return }

    const stack = host.parentElement
    if (!stack) return
    const base = stack.getBoundingClientRect()
    const box = at.table.getBoundingClientRect()
    // The <table> box and the table you can see are not the same width. Several themes set
    // `display: block` so a wide table can scroll, which leaves the block filling the column while
    // the rows inside shrink to their content — measured 458px against 201px in Lapis, which put
    // the delete button a long way to the right of anything visible. Take the rows' width, capped
    // by the box, so a table wider than the column keeps the button at the visible edge.
    const rowWidth = at.table.rows[0]?.getBoundingClientRect().width ?? box.width
    setTableTarget({
      table: at.table,
      column: at.cell.cellIndex,
      rect: {
        top: Math.round(box.top - base.top),
        left: Math.round(box.left - base.left),
        width: Math.round(Math.min(rowWidth || box.width, box.width)),
      },
    })
  }

  /**
   * Whether the bar is over the document or over the chrome.
   *
   * The bar is an overlay in `.ink-editor-stack`, which is not the scroll container — so it tracks
   * the table exactly (measured: a constant 26px above it through every scroll position) but
   * nothing clips it. Scroll the table towards the top and the bar keeps going: measured 14px, then
   * 54px above the scroller's own top edge, drawing over the breadcrumb. That is the bar appearing
   * to float free of the document.
   *
   * It belongs to a table, so it is shown while that table is: gone once the bar would sit above
   * the visible text, and gone once the table has scrolled past the bottom.
   */
  const tableBarFits = (): boolean => {
    const target = tableTargetRef.current
    const el = hostRef.current?.querySelector<HTMLElement>(IR_SCROLLER)
    if (!target || !el) return false
    const view = el.getBoundingClientRect()
    const box = target.table.getBoundingClientRect()
    return box.top - TABLE_BAR_HEIGHT >= view.top && box.top <= view.bottom
  }

  // Whether a new target is inside the visible text. Scrolling is handled by the one listener in
  // the setup effect — there were two of these for a while, and they fought: one hid the bar as
  // the document moved and the other put it back on the next frame, which left it drawn 200px out
  // of place for 170ms. Measured, frame by frame. One owner.
  useEffect(() => { setTableBarVisible(tableTarget === null ? true : tableBarFits()) }, [tableTarget])

  /**
   * Run a table edit, then put the caret and the toolbar back.
   *
   * Dispatching `input` makes Vditor re-serialise the document and **replace the table element**,
   * synchronously — measured: the reference is detached before the call returns. So every reference
   * held across an edit is stale, the toolbar's included, and a caret placed before it is gone.
   * The table is found again by its position among the document's tables, and the caret by row and
   * column index rather than by node.
   */
  const applyTableEdit = (
    mutate: (table: HTMLTableElement) => void,
    caretAfter?: (before: { row: number; column: number }) => { row: number; column: number },
  ): void => {
    const host = hostRef.current
    const at = cellAtCaret()
    if (!host || !at) return

    const tables = () => Array.from(host.querySelectorAll('table'))
    const index = tables().indexOf(at.table)
    const countBefore = tables().length
    const row = at.cell.parentElement instanceof HTMLTableRowElement
      ? at.cell.parentElement.rowIndex
      : 0
    const before = { row, column: at.cell.cellIndex }

    mutate(at.table)
    notifyEdited(at.table)

    // One fewer table than before means this one was the edit's casualty, so there is nothing to
    // put a caret back into — `tables()[index]` would otherwise silently select its neighbour.
    const after = tables()
    if (after.length < countBefore) { setTableTarget(null); return }

    const next = after[index]
    if (!next) { setTableTarget(null); return }

    const want = caretAfter ? caretAfter(before) : before
    const targetRow = next.rows[Math.min(want.row, next.rows.length - 1)]
    const cell = targetRow?.cells[Math.min(want.column, targetRow.cells.length - 1)]
    if (cell) focusCell(cell)
    syncTableTarget()
  }

  useEffect(() => {
    if (!hostRef.current) return
    const host = hostRef.current

    // `selectionchange` is the only event that fires for every way the caret can move — clicking,
    // arrowing, and Vditor's own re-rendering. It is document-wide, so the handler has to check
    // that the selection is still ours.
    const onSelectionChange = () => { syncTableTarget() }
    document.addEventListener('selectionchange', onSelectionChange)

    // The bar is positioned from the table's rect, so anything that moves the table has to
    // re-measure. Resizing can change which cell the caret is in relation to, so it goes the long
    // way; scrolling cannot, so it does not.
    const remeasure = () => { syncTableTarget() }
    window.addEventListener('resize', remeasure)

    /**
     * The bar steps aside while the document is scrolling, and comes back where it belongs.
     *
     * It cannot be made to keep up. It is an overlay in `.ink-editor-stack`, outside the scroll
     * container, so it only moves when the main thread runs a handler — while the content is moved
     * for it, on a fling by the compositor. Every version of "reposition it faster" still moves it
     * a frame or more behind the table it is pinned to, and that is what reads as wobbling.
     * Repositioning through a state update, which is what this did first, is merely the slowest
     * of those.
     *
     * So it does not try. The bar is for acting on a table; while you are scrolling you are
     * reading. It hides on the first scroll event and returns once the scrolling stops, measured
     * fresh — so it is either correct or absent, never trailing.
     */
    let settle = 0
    const onScroll = () => {
      setTableBarVisible(false)
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        syncTableTarget()
        setTableBarVisible(tableBarFits())
      }, SCROLL_SETTLE_MS)
    }
    host.addEventListener('scroll', onScroll, true)

    /**
     * Backspace and Delete at the edge of a code block select it, and only then remove it.
     *
     * Measured: with the caret on the line after a fence, three Backspaces removed four characters
     * **from the paragraph** and left all 41 code blocks standing. Same going forwards with Delete.
     * The block cannot be deleted by walking into it at all — which is the "I have to switch to
     * source mode to get rid of a code block" report, and it is true of every block Vditor renders
     * as a `vditor-ir__node` with a preview inside.
     *
     * The first press selects the block rather than deleting it. Forty lines of code should not
     * disappear on a keystroke aimed at the blank line under them, and once it is selected the
     * ordinary Backspace already works — that path was measured and does remove it.
     */
    const blockDelete = (e: KeyboardEvent) => {
      if (readOnlyRef.current) return
      if (e.key !== 'Backspace' && e.key !== 'Delete') return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const sel = getSelection()
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
      if (!range) return

      const scroller = host.querySelector<HTMLElement>(IR_SCROLLER)
      if (!scroller || !scroller.contains(range.startContainer)) return

      // Second press: the block is already selected, so remove it.
      //
      // The default cannot be left to do this. Vditor handles a non-collapsed Backspace itself and
      // merely collapsed the selection — measured: the node was selected, the key was pressed, and
      // the code block was still there. Removing it here and telling Vditor the document changed
      // is the same path a table edit already takes.
      if (!range.collapsed) {
        const only = selectedBlock(range, scroller)
        if (only === null) return
        e.preventDefault()
        e.stopPropagation()
        const after = only.nextElementSibling ?? only.previousElementSibling
        only.remove()
        scroller.dispatchEvent(new InputEvent('input', { bubbles: true }))
        if (after instanceof HTMLElement) {
          const put = document.createRange()
          put.selectNodeContents(after)
          put.collapse(true)
          sel?.removeAllRanges()
          sel?.addRange(put)
        }
        return
      }

      // The top-level block the caret sits in.
      let block: Node | null = range.startContainer
      while (block && block.parentElement !== scroller) block = block.parentElement
      if (!(block instanceof HTMLElement)) return

      const atStart = isAtEdge(range, block, 'start')
      const atEnd = isAtEdge(range, block, 'end')
      const target = e.key === 'Backspace'
        ? (atStart ? block.previousElementSibling : null)
        : (atEnd ? block.nextElementSibling : null)
      if (!isRenderedBlock(target)) return

      e.preventDefault()
      e.stopPropagation()
      const pick = document.createRange()
      pick.selectNode(target)
      sel?.removeAllRanges()
      sel?.addRange(pick)
    }

    host.addEventListener('keydown', blockDelete, true)

    /**
     * Tab moves between cells, and Enter in the last cell adds a row.
     *
     * Capture on the host for the usual reason: Vditor's keydown listener sits on .vditor-ir and
     * cannot be vetoed from an option. Without this Tab walked out of the table entirely, which
     * is the one table interaction nobody can do without.
     */
    const tableKeys = (e: KeyboardEvent) => {
      if (readOnlyRef.current) return
      const chord = (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey
      if (e.key !== 'Tab' && e.key !== 'Enter' && !chord) return
      if (!chord && (e.metaKey || e.ctrlKey || e.altKey)) return
      const at = cellAtCaret()
      if (!at || !host.contains(at.table)) return

      // Vditor binds these two itself and they do reach the page — but its inserted cells carry no
      // `align`, so adding a row to an aligned column silently dropped the alignment on that row.
      // Routing them through our own operations keeps the key, the menu item and the bar in
      // agreement. The other four of its bindings are unreachable anyway: ⌘= and ⌘- are the
      // browser's zoom, and ⇧⌘= / ⇧⌘- never match its own hotkey test.
      if (chord && (e.code === 'KeyF' || e.code === 'KeyG')) {
        e.preventDefault()
        e.stopPropagation()
        const column = at.cell.cellIndex
        const row = at.cell.parentElement instanceof HTMLTableRowElement
          ? at.cell.parentElement.rowIndex
          : 0
        if (e.code === 'KeyF') {
          applyTableEdit(
            (table) => { insertRow(table, row, 'above') },
            (before) => ({ row: Math.max(1, before.row), column: before.column }),
          )
        } else {
          applyTableEdit((table) => { insertColumn(table, column, 'left') })
        }
        return
      }
      if (chord) return

      const last = at.table.rows[at.table.rows.length - 1]?.cells
      const inLastCell = last ? last[last.length - 1] === at.cell : false

      // Enter only at the very end, and Tab off the end: both grow the table the way a
      // spreadsheet does, landing the caret in the first cell of the new row. Everywhere else
      // Enter belongs to Vditor, which uses it to leave the table — the only keyboard way out.
      const growsTable = inLastCell && (e.key === 'Enter' || !e.shiftKey)
      if (e.key === 'Enter' && !inLastCell) return
      if (growsTable) {
        e.preventDefault()
        e.stopPropagation()
        applyTableEdit(
          (table) => { insertRow(table, table.rows.length - 1, 'below') },
          () => ({ row: at.table.rows.length, column: 0 }),
        )
        return
      }

      const next = neighbourCell(at.table, at.cell, e.shiftKey ? -1 : 1)
      if (!next) return
      e.preventDefault()
      e.stopPropagation()
      focusCell(next)
      syncTableTarget()
    }
    host.addEventListener('keydown', tableKeys, true)

    // Right-click in a cell. Capture, so it beats Vditor's own handling, and only inside a table —
    // everywhere else the browser's own menu (spelling, copy, look up) is the right one.
    const openTableMenu = (cell: HTMLTableCellElement, at: { x: number; y: number }) => {
      const table = tableFrom(cell)
      if (!table) return
      // The caret has to land in the cell it was opened on: every item acts on where it is.
      focusCell(cell)
      syncTableTarget()
      setTableMenu({
        at,
        row: cell.parentElement instanceof HTMLTableRowElement ? cell.parentElement.rowIndex : 0,
        column: cell.cellIndex,
        rows: table.rows.length,
        columns: columnCount(table),
      })
    }

    const onContextMenu = (e: MouseEvent) => {
      if (readOnlyRef.current) return
      const cell = cellFrom(e.target as Node | null)
      const table = cell ? tableFrom(cell) : null
      if (!cell || !table || !host.contains(table)) return
      e.preventDefault()
      e.stopPropagation()
      openTableMenu(cell, { x: e.clientX, y: e.clientY })
    }
    host.addEventListener('contextmenu', onContextMenu, true)

    /*
     * Long-press opens the same menu on touch, because there is no right-click to open it with.
     *
     * Cancelled by movement or by lifting early, so it never fires on a scroll or a tap — a
     * touchmove of more than a few pixels is a scroll, not a press. Chrome also raises its own
     * `contextmenu` from a long press on some devices, which the handler above would answer, so
     * the timer clears itself once the menu is open and cannot open it twice.
     */
    let pressTimer = 0
    let pressAt: { x: number; y: number } | null = null

    const clearPress = () => {
      if (pressTimer) window.clearTimeout(pressTimer)
      pressTimer = 0
      pressAt = null
    }

    const onTouchStart = (e: TouchEvent) => {
      if (readOnlyRef.current || e.touches.length !== 1) return
      const touch = e.touches[0]!
      const cell = cellFrom(e.target as Node | null)
      if (!cell || !tableFrom(cell) || !host.contains(cell)) return
      pressAt = { x: touch.clientX, y: touch.clientY }
      pressTimer = window.setTimeout(() => {
        pressTimer = 0
        openTableMenu(cell, pressAt ?? { x: touch.clientX, y: touch.clientY })
      }, 500)
    }

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0]
      if (!pressAt || !touch) return
      if (Math.hypot(touch.clientX - pressAt.x, touch.clientY - pressAt.y) > 8) clearPress()
    }

    host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    host.addEventListener('touchmove', onTouchMove, { capture: true, passive: true })
    host.addEventListener('touchend', clearPress, true)
    host.addEventListener('touchcancel', clearPress, true)

    // Vditor hard-codes Ctrl/Cmd+Alt+7/8/9 to switch between wysiwyg / ir / sv modes.
    // This app is IR-only — the Lapis theme and the shell CSS are scoped to .vditor-ir,
    // and there is no UI to switch back — so a stray press leaves a broken editor.
    //
    // It has to be a capture-phase listener on the host: Vditor calls options.keydown from
    // inside its own listener on .vditor-ir, ignores the return value, and never checks
    // defaultPrevented, so the option cannot veto it. A capture listener on an ancestor
    // runs strictly earlier, and stopPropagation there keeps the event from arriving.
    const blockEditModeSwitch = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && /^Digit[789]$/.test(e.code)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    host.addEventListener('keydown', blockEditModeSwitch, true)

    // Read-only has to stop the click before Vditor's own handler on .vditor-ir sees it —
    // same reason as above, its listener is not something an option can veto. Capture on the
    // host runs strictly earlier, and stopping there never reaches the descendant.
    // Text selection is unaffected: the browser does that on mousedown and drag, not on click,
    // so a read-only document can still be selected and copied.
    const blockExpandWhenReadOnly = (e: MouseEvent) => {
      if (!readOnlyRef.current) return
      // Chrome attached to a block, not the block itself. The copy button and links are the
      // reasons to be in read-only mode at all, so blocking every click took away the two
      // things reading is for — the copy button silently stopped filling the clipboard.
      const t = e.target as Element | null
      // A link in IR is a span[data-type="a"], never an <a href> — Vditor opens it from its own
      // click handler, which is the handler being blocked here.
      if (t?.closest?.('.vditor-copy, [data-type="a"]')) return
      e.stopPropagation()
    }
    host.addEventListener('click', blockExpandWhenReadOnly, true)

    // Mirror each fenced block's language onto its node as data-lang, which the corner label is
    // then drawn from with a ::after. Vditor's own language span is real text inside the
    // document: simply moving it into the corner put it back into the selection, so a copied
    // block came out with "js" appended (measured against the previous build, where the span was
    // clipped to 0x0 and Chrome skipped it). Pseudo-element content is never selectable.
    //
    // childList/characterData only — deliberately not attributes, so writing data-lang here
    // cannot retrigger the observer.
    const syncCodeLanguages = () => {
      host.querySelectorAll<HTMLElement>('.vditor-ir__node[data-type="code-block"]').forEach((node) => {
        const info = node.querySelector('.vditor-ir__marker--info')
        const lang = (info?.textContent ?? '').replace(/​/g, '').trim()
        if (node.dataset.lang !== lang) node.dataset.lang = lang
      })
    }
    let pending = 0
    const observer = new MutationObserver(() => {
      if (pending) return
      pending = requestAnimationFrame(() => { pending = 0; syncCodeLanguages() })
    })
    observer.observe(host, { childList: true, subtree: true, characterData: true })
    // Pictures. A note refers to `/assets/…`, which is not a URL a browser can resolve in either
    // route — see `assets/images.ts` for why this is a watcher rather than a pass.
    const stopImages = showAssetImages(host)
    // GitHub's five callouts. A blockquote whose first line names one — see `alerts.ts`.
    const stopAlerts = showAlerts(host)

    /*
     * Following a link: a modifier while editing, a plain click while reading.
     *
     * In IR a link is a `span[data-type="a"]` whose address is a `.vditor-ir__marker--link` child,
     * never an `<a href>` — so this reads the marker rather than the DOM's own idea of a link.
     * Capture phase, because Vditor's own click handler runs on the way back up and would move the
     * caret into a link the reader only wanted to follow.
     */
    const followLinkClick = (e: MouseEvent) => {
      if (!(e.metaKey || e.ctrlKey || readOnlyRef.current)) return
      const node = (e.target as Element | null)?.closest?.('[data-type="a"]')
      const href = node?.querySelector(':scope > .vditor-ir__marker--link')?.textContent ?? ''
      if (href === '') return
      if (!followLink(href, currentPath.value)) return
      e.preventDefault()
      e.stopPropagation()
    }
    host.addEventListener('click', followLinkClick, true)

    const vd = new Vditor(host, {
      mode: 'ir',
      cdn: '/vditor',
      // Vditor's own default is 'zh_CN', which makes it load the Chinese i18n bundle
      // and render all of its built-in UI text (hints, tooltips, code-block language
      // input, upload messages) in Chinese.
      lang: 'en_US',
      preview: {
        theme: { current: 'light', path: '/vditor/dist/css/content-theme' },
      },
      toolbar: [],
      cache: { enable: false },
      /**
       * Links are this application's to follow, not Vditor's.
       *
       * Left alone, a *plain* click hands the href to `window.open` — and for `./other.md` that
       * means the browser leaves the page for a path the server answers with `index.html`, which
       * looks exactly like the application reloading itself. `isOpen: false` stops that; the
       * capture-phase listener below decides what a click means, so the gesture is the same one
       * the other engine uses.
       */
      link: { isOpen: false },
      /**
       * Where a pasted or dropped picture goes.
       *
       * Vditor's own hook, rather than a paste listener of ours: with a handler configured it
       * stops before its fallback — which is a base64 data URL inlined into the markdown, i.e. a
       * megabyte of text in a note. Text still wins, upstream of this; `handler` is only reached
       * when the clipboard carried files and nothing else.
       *
       * `multiple` is Vditor's, and off by default: without it a drop of three screenshots is
       * silently one.
       */
      upload: {
        multiple: true,
        handler(files: File[]) {
          pasteRef.current(files)
          // A string here is an error in Vditor's own tip bubble. Ours is the line under the
          // picture, which can say what was refused and how big it was.
          return null
        },
      },
      input(value: string) {
        if (settingRef.current) return
        // Filter the async input echo triggered by setValue: Vditor asynchronously dispatches
        // an input after setValue, but settingRef is reset synchronously in finally, so it can't
        // block this late echo. Ignore it when the value matches what we just synced; otherwise
        // "opening a file" would be wrongly marked dirty.
        if (value === lastSyncedRef.current) return
        lastSyncedRef.current = value
        editContent(value)
      },
      keydown(e: KeyboardEvent) {
        // Vditor's input callback is debounced by ~800ms. When the user types and quickly hits
        // Ctrl+S, input hasn't fired yet and content is still the old value, so saving directly
        // would persist stale content or even lose characters. Here, within the same Ctrl+S event,
        // we synchronously flush the editor's current value into content first (and align
        // lastSyncedRef to avoid the push-back effect below calling setValue on a differing value
        // and jumping the cursor). The actual save is not done here — the event keeps bubbling to
        // the global keydown in App.tsx, which handles flushSave + refreshing git status in one
        // place, avoiding two concurrent saves from a single keypress.
        if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
          const v = vd.getValue()
          if (v !== content.value) {
            lastSyncedRef.current = v
            editContent(v)
          }
        }
      },
      after() {
        readyRef.current = true
        settingRef.current = true
        try {
          vd.setValue(content.value)
          // Same reason as the sync effect below: the file's own arrival must not be undoable.
          clearUndoAfterRender(vd)
        } finally {
          settingRef.current = false
        }
        lastSyncedRef.current = content.value
        // The shared name for "the element the document scrolls in", so the outline and the
        // search highlighter do not have to know whose editor is mounted. See `surface.ts`.
        host.querySelector(IR_SCROLLER)?.classList.add(DOC_SURFACE)
        syncCodeLanguages()
        syncEditable(vd)
        // Sync Vditor's own UI chrome to the current theme on first load.
        // contentTheme stays 'light' — our bundled lapis-theme.css dark rules
        // (scoped to :root[data-theme="dark"]) override Vditor's light content
        // theme in dark mode, so no lapis-dark.css file is needed.
        vd.setTheme(resolvedTheme.value === 'dark' ? 'dark' : 'classic', 'light')
      },
    })
    vditorRef.current = vd
    return () => {
      host.removeEventListener('keydown', blockEditModeSwitch, true)
      host.removeEventListener('click', blockExpandWhenReadOnly, true)
      host.removeEventListener('click', followLinkClick, true)
      host.removeEventListener('keydown', tableKeys, true)
      host.removeEventListener('keydown', blockDelete, true)
      host.removeEventListener('contextmenu', onContextMenu, true)
      host.removeEventListener('touchstart', onTouchStart, true)
      host.removeEventListener('touchmove', onTouchMove, true)
      host.removeEventListener('touchend', clearPress, true)
      host.removeEventListener('touchcancel', clearPress, true)
      clearPress()
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('resize', remeasure)
      host.removeEventListener('scroll', onScroll, true)
      window.clearTimeout(settle)
      observer.disconnect()
      stopImages()
      stopAlerts()
      if (pending) cancelAnimationFrame(pending)
      try { vd.destroy() } catch { /* tolerate jsdom/teardown errors */ }
      vditorRef.current = null
      readyRef.current = false
    }
  }, [])

  // Re-theme Vditor whenever the app's resolved theme (light/dark) changes.
  useEffect(() => {
    const vd = vditorRef.current
    if (!vd || !readyRef.current) return
    vd.setTheme(resolvedTheme.value === 'dark' ? 'dark' : 'classic', 'light')
  }, [resolvedTheme.value])

  // Push content into the editor when content changes wholesale (not from user input):
  // opening a file, an external reload, or taking the disk version. Use lastSyncedRef rather
  // than vd.getValue() for the check: during rapid consecutive typing, getValue() runs ahead
  // of content (returning a mid-typing updated value), which would misjudge "needs push-back"
  // and setValue an older content back into the editor, swallowing what the user just typed.
  // lastSyncedRef records the value on which the editor and content already agree, so a
  // push-back is only truly needed when something external changes content to a different value.
  useEffect(() => {
    const vd = vditorRef.current
    if (!vd || !readyRef.current) return
    // Nothing is pushed through the renderer while the source view is open. Two reasons, and both
    // are the point of that mode: an intermediate state that is not yet valid markdown would be
    // re-rendered under the caret on every keystroke, and — because a round-trip through lute
    // reformats the whole document — text typed as source would come back rewritten. Held until
    // the mode closes, when this effect runs again and syncs once.
    if (sourceMode.value) return

    const next = content.value
    if (next !== lastSyncedRef.current) {
      settingRef.current = true
      lastSyncedRef.current = next
      try {
        // Clear the undo stack on *both* sides of the set.
        //
        // Before, and not with `setValue(next, true)`: that flag looks equivalent and is not. It
        // renders, then calls `processAfterRender({ enableAddUndoStack: true })`, which runs
        // diff-match-patch over the whole outgoing document against the whole incoming one — and
        // only then clears the stack and throws the result away. Profiled while opening a
        // 108K-character note: `diff_bisect_` alone took 211ms of a 406ms main-thread block, a
        // visible freeze on a click. Clearing first leaves `lastText` empty, so the same diff is an
        // insert against nothing and returns immediately.
        //
        // After, because clearing first is exactly what makes the entry `setValue` then pushes a
        // record of "empty → this note". **One Ctrl+Z on a freshly opened file emptied it** —
        // measured, 30,836 characters to 0 — and there was nothing left to undo back to. Nothing
        // that arrived with the file should be undoable; the first thing on the stack has to be
        // something the reader did.
        vd.clearStack()
        vd.setValue(next)
        clearUndoAfterRender(vd)
      } finally {
        settingRef.current = false
      }
    }
    syncEditable(vd)
    // Read-only takes the bar away, and closing a file takes it away with the document.
    syncTableTarget()
  }, [content.value, currentPath.value, readOnly.value, sourceMode.value])

  return (
    <div class="ink-editor-stack" ref={stackRef}>
      <div class="ink-editor" ref={hostRef} />
      {line && <PasteLine line={line} />}
      {tableTarget && (
        <TableToolbar
          table={tableTarget.table}
          column={tableTarget.column}
          rect={tableTarget.rect}
          visible={tableBarVisible}
          onAlign={(align) => {
            const column = tableTarget.column
            applyTableEdit((t) => { setColumnAlign(t, column, align) })
          }}
          onResize={(rows: number, cols: number) => {
            applyTableEdit(
              (t) => { resize(t, rows, cols) },
              // Shrinking can strand the caret past the new last row or column.
              (before) => ({
                row: Math.min(before.row, rows - 1),
                column: Math.min(before.column, cols - 1),
              }),
            )
          }}
          onDelete={() => { applyTableEdit(deleteTable) }}
        />
      )}
      {tableMenu && (
        <TableContextMenu
          at={tableMenu.at}
          row={tableMenu.row}
          column={tableMenu.column}
          rows={tableMenu.rows}
          columns={tableMenu.columns}
          onApply={applyTableEdit}
          onClose={() => { setTableMenu(null) }}
        />
      )}
    </div>
  )
}
