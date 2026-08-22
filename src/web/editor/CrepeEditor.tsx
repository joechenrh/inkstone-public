// Order matters and is the same rule `document.css` states: the library's own base first, then the
// stylesheet that overrides it. Crepe's theme was imported last, so its `.milkdown .milkdown-toolbar`
// beat ours on source order at equal specificity — the toolbar stayed 52px tall and transparent.
import '@milkdown/crepe/theme/common/style.css'
import './document.css'
import './crepe-shell.css'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Crepe, CrepeFeature } from '@milkdown/crepe'
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import type { EditorView } from '@milkdown/kit/prose/view'
import { TextSelection } from '@milkdown/kit/prose/state'
import { imageSchema, remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark'
import { replaceAll } from '@milkdown/kit/utils'
import { codeCompletion, codeHighlighting, codeIndent } from './code-highlight.js'
import { linkInputRule, linkPasteRule } from './link-input.js'
import { tableRowInput } from './table-input.js'
import { fenceInput } from './fence-input.js'
import { deleteEmptyTable, openLineBesideWall } from './block-escape.js'
import { marksEndAtTheirMarker } from './mark-inclusivity.js'
import { closeMarksOn, collapseMarks, markReveal, marksAreOpen } from './mark-reveal.js'
import { closeSourceAndSplit, closeSourceOn, collapseSource, sourceIsOpen, sourceReveal } from './source-reveal.js'
import { writeWhatWasTyped } from './markdown-escapes.js'
import { attachImagePaste } from './image-paste.js'
import { markerReveal } from './marker-reveal.js'
import { alertReveal } from './alert-reveal.js'
import { showAssetImages } from '../assets/images.js'
import { PasteLine } from '../assets/PasteLine.js'
import { useImagePaste } from '../assets/usePaste.js'
import { content, editContent } from '../state/document.js'
import { readOnly, sourceMode } from '../state/settings.js'
import { currentPath } from '../state/vault.js'
import { DOC_SURFACE } from './surface.js'
import { TableToolbar } from './TableToolbar.js'
import { alignColumn, deleteTable, resizeTable, tableAtCaret, type TableTarget } from './crepe-table.js'

/**
 * The document, in Crepe.
 *
 * Chosen over Vditor on the evidence in `docs/design/editor-engine.md`: it has a document model, so
 * undo, deletion and selection are operations on markdown rather than guesses about a DOM. Four of
 * the seven complaints from the first week of real use were the same complaint, and it was that.
 *
 * The contract with the rest of the application is unchanged and is entirely signals — `content`,
 * `currentPath`, `readOnly`, `sourceMode`. Nothing outside this directory knows which engine is
 * mounted; the outline and the search highlighter find the document through `DOC_SURFACE`.
 */

/** Vditor kept this at ~800ms. Crepe hands us markdown synchronously, so this is only coalescing. */
const INPUT_DEBOUNCE_MS = 120

/** How long after the last scroll event the table bar comes back. The other shell's number. */
const SCROLL_SETTLE_MS = 120

/** How far above a table the bar sits — `margin-top: -26px` in `table.css`, plus its own height. */
const TABLE_BAR_HEIGHT = 26

/**
 * The pointer says what the modifier would do.
 *
 * Without this the affordance is invisible — the reader has to know the gesture already. Holding
 * the key turns every link into something that looks clickable, which is the whole hint.
 */
/**
 * The language menu closes when the pointer leaves the block it belongs to.
 *
 * The controls are shown on hover, but the menu's open/shut is Crepe's own state — so opening it
 * and moving away only took the card off the screen: the menu was still open underneath, and the
 * next hover brought it straight back. A menu nobody is pointing at is shut.
 *
 * Toggled through its own button rather than by hiding it, so Crepe's state and what is on screen
 * stay the same thing.
 */
function closePickerOnLeave(e: MouseEvent): void {
  const block = (e.target as Element | null)?.closest?.('.milkdown-code-block')
  if (!block) return
  const to = e.relatedTarget
  if (to instanceof Node && block.contains(to)) return
  // `data-expanded` on the trigger is the menu's own state; the element merely existing is not,
  // which is what the first attempt at this checked and why it never fired.
  if (block.querySelector('[data-expanded="true"]') === null) return
  // Closed the way Crepe closes it: a click outside. Its own listener is on `window` and decides by
  // where the click landed, so this is the same event a click on the page would produce — clicking
  // the trigger instead would have toggled, and from a menu that is open that means opening it
  // again on the way past.
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function trackModifier(e: KeyboardEvent): void {
  const host = e.currentTarget as HTMLElement
  host.classList.toggle('ink-crepe-open-links', e.metaKey || e.ctrlKey)
}

/**
 * The note's markdown, with everything that is open closed first — on a copy.
 *
 * `given` is what the editor serialised from what is on screen, which is right whenever nothing is
 * open, and that is nearly always. See `mark-reveal.ts`.
 */
function closedMarkdown(ctx: Ctx, given: string): string {
  const view = ctx.get(editorViewCtx)
  if (!marksAreOpen(view.state) && !sourceIsOpen(view.state)) return given
  let tr = view.state.tr
  tr = closeMarksOn(view.state, tr, ctx)
  tr = closeSourceOn(view.state, tr, ctx)
  return ctx.get(serializerCtx)(tr.doc)
}

export function CrepeEditor() {
  const hostRef = useRef<HTMLDivElement>(null)
  const stackRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<Crepe | null>(null)
  const { line, paste } = useImagePaste(stackRef, (_markdown, path) => {
    const crepe = crepeRef.current
    if (!crepe) return
    // A node rather than the text of one: this editor has a document model, and inserting `![](…)`
    // as characters would leave it to an input rule that fires on typing.
    crepe.editor.action((c) => {
      const view = c.get(editorViewCtx)
      const image = imageSchema.type(c).create({ src: `/${path}` })
      view.dispatch(view.state.tr.replaceSelectionWith(image).scrollIntoView())
    })
  })
  const pasteRef = useRef(paste)
  pasteRef.current = paste
  /** The value the editor and `content` agree on — the same discipline the Vditor shell needed. */
  const lastSyncedRef = useRef<string>('')
  /** True while we are pushing a value in, so the echo is not read back as the reader typing. */
  const settingRef = useRef(false)
  const readyRef = useRef(false)
  /** Re-measures the bar. Held in a ref because it is defined inside the mount effect and used by
      the handlers the render puts on the bar. */
  const syncTableRef = useRef<() => void>(() => {})
  /** The current target, for handlers that outlive a render. */
  const tableRef = useRef<TableTarget | null>(null)
  /** False while the document is scrolling — the bar steps aside rather than trailing the table. */
  const [tableBarVisible, setTableBarVisible] = useState(true)
  /** The table the caret is in, and where to draw the bar. Null whenever it is in none. */
  const [table, setTable] = useState<(TableTarget & { rect: { top: number; left: number; width: number } }) | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let debounce = 0
    // What the editor is actually being built with. `content` can change while `create()` is still
    // resolving — on the GitHub route the repository, the token and the first file all arrive
    // asynchronously — and recording the *later* value as "what the editor shows" makes the sync
    // effect below decide there is nothing to push. The document then stays empty for good, which
    // is exactly what opening a file looked like.
    const mountedWith = content.value
    const crepe = new Crepe({
      root: host,
      defaultValue: mountedWith,
      features: {
        // NOT turned off, though it was, and that cost something worth naming. This feature is two
        // things: a *virtual* caret — thinner and paler than the one the operating system draws,
        // and reported as invisible against these themes — and the gap cursor, which is the only
        // way to put a caret *between* two blocks. Switching the feature off took both, so two
        // consecutive fences had nowhere between them: pressing Up from the second walked into the
        // first instead of offering a line to type on. Only the virtual caret is declined, below.
        // Maths: `$x$` inline and `$$…$$` as a block, asked for. It was declined once because
        // these notes are about linkers and assembly and `push $0x1` is not maths — that stays
        // true of *prose*, where a pair of dollar signs on one line is now a formula. Inside a
        // fence nothing is claimed, which is where the assembly is.
        [CrepeFeature.Latex]: true,
        // The application has a top bar, and it is not this one.
        [CrepeFeature.TopBar]: false,
        // The block handle — a plus button and a drag grip in the margin of every block. It is a
        // second way to do what typing already does, it moves as the pointer moves, and it puts
        // furniture in the gutter this application keeps empty on purpose. The slash menu goes with
        // it, which is the same feature.
        [CrepeFeature.BlockEdit]: false,
        // A placeholder on *every* empty block, not just an empty document — so a note with air in
        // it is full of "Please enter…". Blank lines are punctuation in prose; they should look
        // blank.
        [CrepeFeature.Placeholder]: false,
        [CrepeFeature.AI]: false,
        // Crepe follows a caret entering a link with a floating bar carrying the URL and three
        // buttons. Typora does none of that: the link is text, the caret goes into it like any
        // other text, and `Cmd/Ctrl+click` opens it. That is the behaviour asked for and it is the
        // one that leaves the page still. `openLinkOnModifierClick` below is the other half.
        [CrepeFeature.LinkTooltip]: false,
        // The block image: an upload button, a caption, and drag handles for a width markdown has
        // nowhere to put. It also writes the *aspect ratio into the alt text* — its serialiser is
        // literally `alt: Number.parseFloat(node.attrs.ratio).toFixed(2)` — so every picture in a
        // note opened here came back as `![1.00](…)`, whatever its alt had been. That is not a
        // feature with a bug in it; it is a feature this application would have had to undo. An
        // inline image is the commonmark node, and it round-trips.
        [CrepeFeature.ImageBlock]: false,
      },
      featureConfigs: {
        // The gap cursor and the drop cursor stay; the pale caret does not. See the note above.
        [CrepeFeature.Cursor]: { virtual: false },
        // The fenced block's colours, matched to the ones the other engine has always used. See
        // `code-highlight.ts` — the values are read off Vditor's own highlight.js stylesheet.
        [CrepeFeature.CodeMirror]: {
          theme: codeHighlighting,
          extensions: [...codeIndent, codeCompletion],
          // A formula block is its formula, the way Typora shows one: the source is what you get
          // when you go into it. Crepe's default opens both at once, so `$$…$$` was a fenced block
          // of backslashes with the rendered maths underneath it — twice the height and neither
          // one the document. Only blocks that *have* a preview are affected; a fence of
          // JavaScript has none and is unchanged.
          previewOnlyByDefault: true,
        },
        // A formula that does not parse is shown in red where it stands, rather than throwing —
        // half-typed maths is the normal state of a formula being written.
        [CrepeFeature.Latex]: { katexOptions: { throwOnError: false } },
      },
    })
    crepeRef.current = crepe
    // Before `create()`: a Milkdown editor takes its plugins while it is being built. See
    // `link-input.ts` — without these, `[1](2)` typed into a note is not a link and is saved
    // escaped, which is the only way this application could not write one.
    crepe.editor.use(linkInputRule).use(linkPasteRule).use(sourceReveal).use(markerReveal).use(markReveal).use(alertReveal).use(tableRowInput).use(fenceInput)
    // A run of emphasis ends where its closing `*` is; see `mark-inclusivity.ts`.
    for (const schema of marksEndAtTheirMarker) crepe.editor.use(schema)
    // Crepe has an upload button and no paste handler; see `image-paste.ts`.
    // A note refers to `/assets/…`, which is not a URL a browser can resolve in either route.
    const stopImages = showAssetImages(host)
    // Pasting and dropping a picture, taken before ProseMirror sees it — see `image-paste.ts`.
    const stopPaste = attachImagePaste(host, (files, at) => {
      const view = crepeRef.current?.editor.ctx.get(editorViewCtx)
      if (view !== undefined && at !== null) {
        const pos = view.posAtCoords({ left: at.x, top: at.y })
        if (pos) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos.pos)))
        view.focus()
      }
      pasteRef.current(files)
    })
    // See `markdown-escapes.ts`: a literal `[` is written as one, and a trailing space is not
    // written as `&#x20;`.
    crepe.editor.config(writeWhatWasTyped)
    // Milkdown keeps a blank line across a round trip by writing `<br />` into the markdown for
    // every empty paragraph. In a vault kept in git that is HTML appearing in a note nobody put
    // there — pressing Enter twice wrote two of them — and an empty cell in a new table came out as
    // `| <br /> |`. A blank line between two blocks is a separator in markdown and does not need
    // preserving; the other engine writes nothing for it either.
    crepe.editor.remove(remarkPreserveEmptyLinePlugin)

    crepe.on((listener) => {
      listener.markdownUpdated((c, given) => {
        // Echoes of our own `setValue` are not edits. Vditor needed a synchronous guard *and* a
        // value comparison because its echo was async; both are cheap and both are kept.
        if (settingRef.current || !readyRef.current) return
        // What is read is the document with nothing open, whatever is on screen. While a run or a
        // link is showing its own markdown the document holds literal `` ` `` and `[`, and this is
        // the text that goes on to be the draft in local storage, what a commit reads and what
        // source mode shows — so without this a stray marker could reach a note without anyone
        // having saved while one was open. Nothing is dispatched: the reader keeps what they see.
        const markdown = closedMarkdown(c, given)
        if (markdown === lastSyncedRef.current) return
        window.clearTimeout(debounce)
        debounce = window.setTimeout(() => {
          lastSyncedRef.current = markdown
          editContent(markdown)
        }, INPUT_DEBOUNCE_MS)
      })
    })

    void crepe.create().then(() => {
      if (disposed) { void crepe.destroy(); return }
      readyRef.current = true
      lastSyncedRef.current = mountedWith
      const surface = host.querySelector<HTMLElement>('.ProseMirror')
      surface?.classList.add(DOC_SURFACE)
      crepe.setReadonly(readOnly.value)
      // And catch up, if it moved while we were starting.
      if (content.value !== mountedWith) {
        settingRef.current = true
        lastSyncedRef.current = content.value
        try {
          crepe.editor.action(replaceAll(content.value, true))
        } finally {
          settingRef.current = false
        }
      }
    })

    // Before the application's own save handler sees the key. While a link is open the document
    // holds literal `[text](url)`, and a serialiser escapes literal brackets — so a save at that
    // instant would write `\[text\](url)` into the note. Closing first, in the capture phase,
    // means what gets read is a link. See `source-reveal.ts`.
    const closeLinkBeforeSave = (e: KeyboardEvent) => {
      if (!(e.key === 's' && (e.metaKey || e.ctrlKey))) return
      const crepe = crepeRef.current
      if (!crepe) return
      crepe.editor.action((c) => {
        collapseSource(c.get(editorViewCtx), c)
        collapseMarks(c.get(editorViewCtx), c)
      })
      // Synchronously, because the save is about to read `content` and the editor's own update is
      // debounced. The Vditor shell flushes on Ctrl+S for the same reason.
      settingRef.current = true
      try {
        const md = crepe.getMarkdown()
        lastSyncedRef.current = md
        editContent(md)
      } finally {
        settingRef.current = false
      }
    }
    host.addEventListener('keydown', closeLinkBeforeSave, true)

    /*
     * Enter, while a link or a picture is showing its own markdown.
     *
     * The document holds literal `![](/assets/…)` at that moment, so a plain Enter splits the
     * *address* — a picture clicked and then split came back as `![⏎11](…)`. Closing first and
     * splitting after is what Enter would have done if the source had never been on screen.
     *
     * Capture phase, like everything else that has to reach a key before ProseMirror's own keymap.
     */
    const closeSourceOnEnter = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const crepe = crepeRef.current
      if (!crepe) return
      let handled = false
      crepe.editor.action((c) => {
        // A run showing its own markdown closes first, so the newline splits a line of text rather
        // than a line of asterisks. See `mark-reveal.ts`; the link and the picture below are the
        // same hazard and take the same route out.
        collapseMarks(c.get(editorViewCtx), c)
        handled = closeSourceAndSplit(c.get(editorViewCtx), c)
      })
      if (!handled) return
      e.preventDefault()
      e.stopPropagation()
    }
    host.addEventListener('keydown', closeSourceOnEnter, true)

    /**
     * Where the bar goes, in the editor's own coordinates rather than the viewport's — it is an
     * overlay inside `.ink-editor-stack`, so it scrolls with the document instead of hanging in
     * the air. The same arrangement, and the same reason, as the other engine's.
     */
    const syncTable = () => {
      const crepe = crepeRef.current
      if (!crepe || !readyRef.current || readOnly.value) { tableRef.current = null; setTable(null); return }
      crepe.editor.action((c) => {
        const view = c.get(editorViewCtx)
        const at = view.hasFocus() || view.dom.contains(document.activeElement) ? tableAtCaret(view, c) : null
        const stack = host.parentElement
        if (!at || !stack) { tableRef.current = null; setTable(null); return }
        const base = stack.getBoundingClientRect()
        const box = at.dom.getBoundingClientRect()
        // The rows' width rather than the box's: a table that scrolls has a block box as wide as
        // the column and rows only as wide as their content, and the bar belongs over what is
        // visible. The other engine's shell arrived at this the same way.
        const rowWidth = at.dom.rows[0]?.getBoundingClientRect().width ?? box.width
        tableRef.current = at
        setTable({
          ...at,
          rect: {
            top: Math.round(box.top - base.top),
            left: Math.round(box.left - base.left),
            width: Math.round(Math.min(rowWidth || box.width, box.width)),
          },
        })
      })
    }
    syncTableRef.current = syncTable

    /**
     * The bar steps aside while the document is scrolling, and comes back where it belongs.
     *
     * It cannot be made to keep up. It is an overlay in `.ink-editor-stack`, outside the scroll
     * container, so it moves only when the main thread runs a handler — while the content under it
     * is moved by the compositor. Every version of "reposition it faster" still lands a frame or
     * more behind the table it is pinned to, and that trailing is what reads as wobbling. The other
     * engine's shell arrived here the same way, and by the same wrong turns.
     *
     * So it does not try. The bar is for acting on a table; while you are scrolling you are
     * reading. Hidden on the first scroll, back once the scrolling stops, measured fresh — either
     * correct or absent, never trailing.
     *
     * And only when the table is actually on screen: scrolled past, the bar would otherwise sit at
     * the top of the document pointing at nothing.
     */
    const barFits = () => {
      const surface = host.querySelector<HTMLElement>('.ProseMirror')
      const box = tableRef.current?.dom.getBoundingClientRect()
      if (!surface || !box) return false
      const view = surface.getBoundingClientRect()
      return box.top - TABLE_BAR_HEIGHT >= view.top && box.top <= view.bottom
    }
    let settle = 0
    const onScroll = () => {
      setTableBarVisible(false)
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        syncTable()
        setTableBarVisible(barFits())
      }, SCROLL_SETTLE_MS)
    }
    host.addEventListener('scroll', onScroll, true)
    const onResize = () => { syncTable() }
    window.addEventListener('resize', onResize)

    const scheduleSync = () => { window.requestAnimationFrame(syncTable) }
    // `selectionchange` rather than mouse and key events: the caret is what decides whether the bar
    // is there, and it moves after the events that move it. A click on a paragraph fired `mouseup`
    // and the selection was still in the table one frame later, so the bar stayed up.
    // Capture, and before CodeMirror: see `code-escape.ts`. Once the key reaches the code editor's
    // own DOM the selection has already moved and there is nothing left to redirect.
    const escapeCodeBlock = (e: KeyboardEvent) => {
      const crepe = crepeRef.current
      if (!crepe || !readyRef.current) return
      crepe.editor.action((c) => {
        const view = c.get(editorViewCtx)
        if (openLineBesideWall(view, c, e)) return
        deleteEmptyTable(view, c, e)
      })
    }
    host.addEventListener('keydown', escapeCodeBlock, true)

    document.addEventListener('selectionchange', scheduleSync)
    host.addEventListener('focusout', scheduleSync)

    host.addEventListener('mouseout', closePickerOnLeave)
    host.addEventListener('keydown', trackModifier)
    host.addEventListener('keyup', trackModifier)

    return () => {
      disposed = true
      readyRef.current = false
      stopImages()
      stopPaste()
      window.clearTimeout(debounce)
      host.removeEventListener('keydown', closeLinkBeforeSave, true)
      host.removeEventListener('keydown', closeSourceOnEnter, true)
      window.clearTimeout(settle)
      host.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      host.removeEventListener('keydown', escapeCodeBlock, true)
      document.removeEventListener('selectionchange', scheduleSync)
      host.removeEventListener('focusout', scheduleSync)
      host.removeEventListener('mouseout', closePickerOnLeave)
      host.removeEventListener('keydown', trackModifier)
      host.removeEventListener('keyup', trackModifier)
      void crepe.destroy()
      crepeRef.current = null
    }
  }, [])

  /**
   * Push `content` in when it changed somewhere else — a file was opened, a conflict resolved, an
   * agent proposal applied.
   *
   * Diffed against `lastSyncedRef` rather than against the editor's current value, for the reason
   * the Vditor shell records: the editor runs ahead of `content` during fast typing, and comparing
   * against it would push a stale value back over the reader's keystrokes.
   */
  useEffect(() => {
    const crepe = crepeRef.current
    if (!crepe || !readyRef.current) return
    if (sourceMode.value) return
    const next = content.value
    if (next === lastSyncedRef.current) return
    settingRef.current = true
    lastSyncedRef.current = next
    try {
      // Through the editor rather than by remounting: a remount throws away the undo history and
      // the scroll position with it.
      //
      // `flush: true` rebuilds the document rather than diffing into the existing one. That is the
      // expensive option and it is the right one here — this path only runs when the document was
      // replaced wholesale (a file opened, a conflict resolved, an agent's proposal applied), and
      // a diff between two unrelated documents is slower than a rebuild as well as being wrong.
      crepe.editor.action(replaceAll(next, true))
    } finally {
      settingRef.current = false
    }
  }, [content.value, currentPath.value, sourceMode.value])

  useEffect(() => {
    crepeRef.current?.setReadonly(readOnly.value)
  }, [readOnly.value])

  /** One place to run a table edit and put the bar back where the edit left the table. */
  const withTable = (run: (view: EditorView, ctx: Ctx, at: TableTarget) => void) => {
    const crepe = crepeRef.current
    if (!crepe || !table) return
    crepe.editor.action((c) => {
      const view = c.get(editorViewCtx)
      // Found again rather than reused: an earlier edit may have moved it. Cheap, and it is the
      // difference between a bar that works twice in a row and one that does not.
      const at = tableAtCaret(view, c) ?? table
      run(view, c, at)
    })
    window.requestAnimationFrame(() => { syncTableRef.current() })
  }

  return (
    <div class="ink-editor-stack" ref={stackRef}>
      <div class="ink-editor ink-crepe" ref={hostRef} />
      {line && <PasteLine line={line} />}
      {table && (
        <TableToolbar
          table={table.dom}
          column={table.column}
          rect={table.rect}
          visible={tableBarVisible}
          onAlign={(align) => { withTable((view, _c, at) => { alignColumn(view, at, align) }) }}
          onResize={(rows, cols) => { withTable((view, c, at) => { resizeTable(view, c, at, rows, cols) }) }}
          onDelete={() => { withTable((view, _c, at) => { deleteTable(view, at) }) }}
        />
      )}
    </div>
  )
}
