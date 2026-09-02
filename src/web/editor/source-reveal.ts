import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { imageSchema, linkSchema } from '@milkdown/kit/preset/commonmark'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { readOnly } from '../state/settings.js'
import { currentPath } from '../state/vault.js'
import { followLink, resolveLink } from './note-links.js'

/**
 * A link or a picture becomes its own markdown while the caret is in it, and goes back to being a
 * link or a picture when the caret leaves — the way Typora and the previous engine behave.
 *
 * The first version of this drew `[` and `](url)` beside the text as decorations, with the URL in a
 * small input. That showed the source without being the source: the brackets could not be selected,
 * Backspace could not reach them, and there was no way to delete a link by deleting its syntax,
 * which is how anyone who uses markdown deletes a link. So the text really is replaced now.
 *
 * **The cost, stated plainly.** While a link is open the document holds the literal characters
 * `[text](url)`, and a markdown serialiser protects literal brackets — so markdown read at that
 * instant says `\[text\](url)`. That is the same escaping that made links untypeable before, and it
 * is why `collapseSource` exists and why the editor calls it before every save and on every blur.
 * Nothing may read this document for keeps while one of these is open. A picture open as
 * `![alt](/assets/…)` is the same hazard and takes the same route out.
 *
 * Neither the opening nor the closing goes into the undo history. They are not edits — they are the
 * same link, or the same picture, in two presentations — and stepping through them with Ctrl+Z
 * would be undoing something nobody did.
 *
 * A link opens when the caret moves *into* it; a picture opens when it is clicked, because a
 * picture is an atom with no inside for a caret to be in. Both close the moment the selection
 * leaves.
 */

interface Open {
  /** The range currently holding the literal source, mapped forward as the note is edited. */
  from: number
  to: number
  /** What has to be rebuilt when it closes. A picture is a node; a link is a mark on text. */
  kind: 'link' | 'image'
}

const KEY = new PluginKey<Open | null>('inkstoneSourceReveal')

/** `[text](url)`, which is the only shape this ever writes and so the only one it reads back. */
const SOURCE = /^\[([^\]]*)\]\(([^)\s]*)\)$/

/** And the same with the `!` in front of it. */
const IMAGE_SOURCE = /^!\[([^\]]*)\]\(([^)\s]*)\)$/

/** The run of text carrying the link mark the selection is in, with its href — or null. */
function linkAt(selection: EditorState['selection'], ctx: Parameters<typeof linkSchema.type>[0]) {
  const type = linkSchema.type(ctx)
  const { $from, empty } = selection
  if (!empty) return null
  const mark = $from.marks().find((m) => m.type === type)
    // At the very end of a link the caret carries no marks yet; look at what is behind it.
    ?? $from.nodeBefore?.marks.find((m) => m.type === type)
  if (!mark) return null

  // Collected as spans first and chosen afterwards: `Fragment.forEach` has no way to stop, so
  // deciding inside the loop meant the first non-link child after the link cleared the range that
  // had just been found.
  const runs: { from: number; to: number }[] = []
  let pos = $from.start()
  $from.parent.forEach((child) => {
    const at = pos
    pos += child.nodeSize
    if (!child.isText || !mark.isInSet(child.marks)) return
    const last = runs[runs.length - 1]
    if (last && last.to === at) last.to = pos
    else runs.push({ from: at, to: pos })
  })
  const run = runs.find((r) => $from.pos >= r.from && $from.pos <= r.to)
  if (!run) return null
  return { ...run, href: String(mark.attrs.href ?? '') }
}

/**
 * The picture itself, while its markdown is showing.
 *
 * A widget decoration rather than a node, which is the point: the document holds the source text
 * and only the source text, so there is nothing here to serialise and nothing to keep in step. It
 * is what the previous engine draws and what Typora draws — the address on one line, editable, and
 * the picture under it, exactly where it will be when the caret leaves.
 *
 * Replacing the picture with its text alone was the first version, and clicking a picture made the
 * picture disappear. A source line is not a preview of anything.
 */
function preview(src: string, alt: string): HTMLElement {
  const img = document.createElement('img')
  img.className = 'ink-source-preview'
  img.alt = alt
  img.contentEditable = 'false'
  img.draggable = false
  // A vault path is turned into something fetchable by the observer in `assets/images.ts`, the
  // same one that does it for the real picture. An external address is already fetchable.
  img.src = src
  return img
}

/** The picture the selection is *on* — a click selects the node, which is the whole gesture. */
function imageAt(selection: EditorState['selection'], ctx: Parameters<typeof linkSchema.type>[0]) {
  if (!(selection instanceof NodeSelection)) return null
  const node = selection.node
  if (node.type !== imageSchema.type(ctx)) return null
  return {
    from: selection.from,
    to: selection.to,
    src: String(node.attrs.src ?? ''),
    alt: String(node.attrs.alt ?? ''),
  }
}

/**
 * Unfold whatever the selection is in, on the transaction given — a picture, or a link.
 *
 * A function rather than two copies inside `appendTransaction` because it has to run in two places:
 * when the caret moves into something, and **in the same transaction that folds something else up**.
 * ProseMirror calls a plugin's `appendTransaction` with the transactions it has not seen yet, and a
 * transaction the plugin appended itself is not one of them — so there is no second round in which
 * to open anything. Measured: clicking from one link straight to the next opened the first and the
 * third and silently did nothing for the second, because the second click was spent closing the
 * first.
 *
 * `skip` is the range that has just folded up. The caret is sitting against it, and at the end of a
 * link the caret carries the link's mark, so without this the plugin unfolds the thing it has just
 * closed.
 */
function openSourceIn(
  tr: Transaction,
  ctx: Parameters<typeof linkSchema.type>[0],
  skip: { from: number; to: number } | null,
): Transaction | null {
  const overlaps = (r: { from: number; to: number }) =>
    skip !== null && r.from < skip.to && r.to > skip.from

  const image = imageAt(tr.selection, ctx)
  if (image !== null && !overlaps(image)) {
    const source = `![${image.alt}](${image.src})`
    tr.replaceWith(image.from, image.to, tr.doc.type.schema.text(source))
    // The alt text selected, as Typora leaves it: it is the part you are most likely to be there to
    // write, and typing replaces it rather than landing inside the brackets.
    const altFrom = image.from + 2
    const selection = image.alt === ''
      ? TextSelection.create(tr.doc, altFrom)
      : TextSelection.create(tr.doc, altFrom, altFrom + image.alt.length)
    return tr
      .setSelection(selection)
      .setMeta(KEY, { from: image.from, to: image.from + source.length, kind: 'image' })
      .setMeta('addToHistory', false)
  }

  const link = linkAt(tr.selection, ctx)
  if (link === null || overlaps(link)) return null
  const text = tr.doc.textBetween(link.from, link.to, '', '')
  const source = `[${text}](${link.href})`
  // The caret keeps its place in the *text*, which is now one character further along because of
  // the `[` in front of it. Read before the replacement, which is what moves it.
  const caret = Math.min(tr.selection.from + 1, link.from + source.length)
  tr.replaceWith(link.from, link.to, tr.doc.type.schema.text(source))
  return tr
    .setSelection(TextSelection.create(tr.doc, caret))
    .setMeta(KEY, { from: link.from, to: link.from + source.length, kind: 'link' })
    .setMeta('addToHistory', false)
}

/**
 * Turn an open link's text back into a link, on the transaction given.
 *
 * If the text no longer looks like `[text](url)` it is left exactly as it is. That is not a failure
 * case — it is how a link gets deleted: take out a bracket and what stays is the plain text that is
 * left, which is what happens in every markdown editor and what could not happen before.
 */
function collapse(tr: Transaction, open: Open, ctx: Parameters<typeof linkSchema.type>[0]): Transaction {
  const text = tr.doc.textBetween(open.from, open.to, '', '')
  if (open.kind === 'image') {
    const m = IMAGE_SOURCE.exec(text)
    // An empty address is not a picture. Left as text, which is how one gets deleted: take out a
    // bracket, or empty the parentheses, and what stays is what you typed.
    if (m && m[2]) {
      const image = imageSchema.type(ctx).create({ src: m[2], alt: m[1] ?? '', title: '' })
      tr.replaceWith(open.from, open.to, image)
      // The selection is deliberately left alone. Setting it beside the picture sent the caret
      // back to the picture the moment you clicked anywhere else in the note — and took the view
      // with it. ProseMirror maps the click's own position through this change by itself.
    }
    return tr.setMeta(KEY, null).setMeta('addToHistory', false)
  }
  const m = SOURCE.exec(text)
  if (m && m[1]) {
    const type = linkSchema.type(ctx)
    tr.replaceWith(open.from, open.to, tr.doc.type.schema.text(m[1], [type.create({ href: m[2], title: '' })]))
  }
  return tr.setMeta(KEY, null).setMeta('addToHistory', false)
}

/**
 * Close whatever is open, now, from outside the plugin.
 *
 * The editor calls this before it reads markdown for a save and when the document loses focus. It
 * is the guard that keeps the escaped form off the disk.
 */
export function collapseSource(view: EditorView, ctx: Parameters<typeof linkSchema.type>[0]): void {
  const open = KEY.getState(view.state)
  if (!open) return
  view.dispatch(collapse(view.state.tr, open, ctx))
}

/**
 * The document as it would be with nothing open, without changing what is on screen.
 *
 * The counterpart of `withMarksClosed`, and there for the same reason: the open form must not reach
 * the text the application keeps, whether or not anyone remembers to close it first. A link showing
 * `[a](b)` is read as a link even while it is open.
 */
export function closeSourceOn(
  state: EditorState,
  tr: Transaction,
  ctx: Parameters<typeof linkSchema.type>[0],
): Transaction {
  const open = KEY.getState(state)
  if (!open) return tr
  return collapse(tr, { ...open, from: tr.mapping.map(open.from, 1), to: tr.mapping.map(open.to, -1) }, ctx)
}

/** Whether anything is open, so the reader can skip the work when nothing is. */
export function sourceIsOpen(state: EditorState): boolean {
  return KEY.getState(state) != null
}

/**
 * Enter, while something is showing its own markdown: close it first, *then* make the line.
 *
 * Without this the newline lands **inside the source text**, because that is all the document holds
 * while it is open — and a picture opened and split came back as `![⏎11](/assets/…)`, or worse as
 * literal text that a serialiser then escapes into `\![](…)`, which is a picture that can never
 * render again. Measured on both: an Enter after clicking a picture is not an edit to its address.
 *
 * One transaction, so there is no instant in which the document holds a half-closed link. The split
 * goes at the end of what was just closed — the picture, or the link's text — which is where Enter
 * would have gone if the source had never been showing.
 */
export function closeSourceAndSplit(
  view: EditorView,
  ctx: Parameters<typeof linkSchema.type>[0],
): boolean {
  const open = KEY.getState(view.state)
  if (open === null || open === undefined) return false

  const tr = collapse(view.state.tr, open, ctx)
  const end = tr.mapping.map(open.to)
  try {
    tr.split(end)
  } catch {
    // Not a position a block can be split at — leave the close, drop the newline. Better than an
    // exception in a keydown handler, which would take the whole editor with it.
    view.dispatch(tr)
    return true
  }
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 1)).scrollIntoView())
  return true
}

/**
 * Whether this href leads anywhere, and where.
 *
 * It used to be `/^(https?|mailto):/i` here, which meant a link to another note did nothing at all
 * — silently, which is indistinguishable from a broken gesture. Where a path leads is a fact about
 * the vault rather than about this engine, so it is asked of `note-links.ts`.
 */
function leadsSomewhere(href: string): boolean {
  return resolveLink(href, currentPath.value) !== null
}

/**
 * The address of the link at a position, whether it is showing as a link or as its own markdown.
 *
 * Both cases have to work, and only one of them has an `<a>`: a modifier-click lands on a link the
 * caret is not in (so the mark is there) or on one it *is* in (so the mark is gone and the text is
 * `[…](…)`). Reading it out of the DOM handled the first and silently did nothing for the second.
 */
function hrefAt(view: EditorView, ctx: Parameters<typeof linkSchema.type>[0], pos: number): string | null {
  const open = KEY.getState(view.state)
  if (open && pos >= open.from && pos <= open.to) {
    return SOURCE.exec(view.state.doc.textBetween(open.from, open.to, '', ''))?.[2] ?? null
  }
  const $pos = view.state.doc.resolve(pos)
  const type = linkSchema.type(ctx)
  const mark = $pos.marks().find((m) => m.type === type) ?? $pos.nodeAfter?.marks.find((m) => m.type === type)
  return mark ? String(mark.attrs.href ?? '') : null
}

export const sourceReveal = $prose((ctx) =>
  new Plugin<Open | null>({
    key: KEY,
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(KEY) as Open | null | undefined
        if (meta !== undefined) return meta
        if (!value) return null
        /*
         * Mapped rather than recomputed: the reader is typing inside this range, so it moves.
         *
         * The ends are *exclusive*, which is the whole of the difference. Mapped the other way, a
         * character typed immediately after the `)` was swallowed into the range — the text then
         * read `[a](b):`, which is not a link by the pattern below, so it was left as literal
         * markdown on screen and written to the file as `[a](https\://b):`, escaped into something
         * that can never render again. Measured; it is what the bug report was.
         *
         * The same at the front, for a character typed before the `[`.
         */
        const from = tr.mapping.map(value.from, 1)
        const to = tr.mapping.map(value.to, -1)
        return to > from ? { from, to, kind: value.kind } : null
      },
    },
    appendTransaction(trs, _old, state) {
      const open = KEY.getState(state)
      if (open) {
        // Still inside: leave it open, whatever is being typed.
        const { from, to } = state.selection
        if (from >= open.from && to <= open.to) return null
        const tr = collapse(state.tr, open, ctx)
        /*
         * The caret has left. If it has landed in another link — or on a picture — that one is
         * unfolded here, in the same transaction: see `openSourceIn` for why there is no second
         * chance at it. The range that has just folded up is where the caret is standing, and at
         * the end of a link the caret carries the link's own mark, so it is excluded by name.
         */
        const folded = { from: open.from, to: tr.mapping.map(open.to, -1) }
        return openSourceIn(tr, ctx, folded) ?? tr
      }

      /*
       * What this round closed, in the document as it now is.
       *
       * Reopening *that* link is the one thing that must not happen: the caret is still inside it,
       * so the plugin would unfold it again in the very next round and the save that asked for the
       * close would read the open form anyway. Any *other* link is a different question — see
       * below.
       */
      const was = KEY.getState(_old)
      const closed = was !== null && was !== undefined && trs.some((tr) => tr.getMeta(KEY) === null)
        ? trs.reduce(
          (range, tr) => ({ from: tr.mapping.map(range.from, 1), to: tr.mapping.map(range.to, -1) }),
          { from: was.from, to: was.to },
        )
        : null

      /*
       * Opening belongs to the caret *moving into* a link, never to the document changing. Typing
       * `[1](2)` makes a link, and the caret is inside it the instant it exists — so this opened it
       * straight back to `[1](2)` and the link looked like it had never been made. Nobody moved
       * into anything; the link arrived under a caret that was already there.
       *
       * A close of our own is not that kind of change. Clicking from one link straight to another
       * arrives as one round carrying both — the first link folding up, and a click that landed in
       * the second — and refusing every round that touched the document meant the second link did
       * not open. Measured: link, link, link opened the first and the third, and clicking anything
       * else in between made the next one work again.
       */
      if (trs.some((tr) => tr.docChanged && tr.getMeta(KEY) !== null)) return null

      // Reading, not editing. Read mode shows a picture and a link as themselves; unfolding one
      // under a tap is the behaviour the other engine already declines there.
      if (readOnly.value) return null

      // Nothing open. Unfold whatever the caret has moved into, if anything — never the thing that
      // has just folded up under it.
      return openSourceIn(state.tr, ctx, closed)
    },
    props: {
      decorations(state) {
        const open = KEY.getState(state)
        if (!open || open.kind !== 'image') return null
        const m = IMAGE_SOURCE.exec(state.doc.textBetween(open.from, open.to, '', ''))
        if (!m?.[2]) return null
        // Keyed by the address, so typing in the alt text does not reload the picture and typing
        // in the address reloads it exactly once.
        return DecorationSet.create(state.doc, [
          Decoration.widget(open.to, () => preview(m[2] ?? '', m[1] ?? ''), { side: 1, key: `preview:${m[2]}` }),
        ])
      },
      handleDOMEvents: {
        // Focus leaving the document closes the link, so nothing else ever sees the escaped form.
        blur: (view) => { collapseSource(view, ctx); return false },
        /*
         * ProseMirror's own gesture for "select this node" is a click with `metaKey` on a Mac and
         * `ctrlKey` everywhere else — `prosemirror-view/src/input.ts`, `selectNodeModifier`. That
         * is the same gesture as opening a link, so a modifier-click first selected the paragraph,
         * drew a band across it, and only the second one got through.
         *
         * Claiming the `mousedown` stops that from happening at all — and the default is suppressed
         * too, so the caret never lands in the link. Opening one is not a reason to start editing
         * it: the link stayed put and unfolded into `[…](…)` under the pointer, when all that was
         * asked for was to follow it. Read-only mode already behaved this way and this is the same
         * behaviour with the caret available.
         *
         * Suppressing the default was tried once before and made the first click select the whole
         * block — but that was ProseMirror's own fallback, which cannot run now that this returns
         * `true` and takes the event away from it.
         */
        mousedown: (view, event) => {
          const e = event as MouseEvent
          if (!follows(e)) return false
          const at = view.posAtCoords({ left: e.clientX, top: e.clientY })
          const href = at ? hrefAt(view, ctx, at.pos) : null
          if (href === null || !leadsSomewhere(href)) return false
          e.preventDefault()
          return true
        },
        /*
         * `Cmd`/`Ctrl` and a click opens the link while editing, and a plain click while reading — Typora's
         * rule, and the one the two engines now share. Reading is what read mode is for; requiring a
         * modifier there was asking for a key to do the only thing on the screen.
         *
         * On `click`, which took three tries to get right. On `click` with the address read from
         * the `<a>` it worked only while the caret was elsewhere, because entering the link turns
         * it into its own markdown and there is no anchor left. On `mousedown` with the default
         * suppressed, ProseMirror fell back to selecting the whole block, so the first click lit
         * the line up and only the second opened anything. On `mousedown` without that, opening
         * was intermittent.
         *
         * It is `click` and `hrefAt` reads the model, which knows the address in both states — so
         * the gesture is the ordinary one and it works wherever the caret happens to be.
         */
        click: (view, event) => {
          const e = event as MouseEvent
          if (!follows(e)) return false
          const at = view.posAtCoords({ left: e.clientX, top: e.clientY })
          if (!at) return false
          const href = hrefAt(view, ctx, at.pos)
          if (href === null || href === '') return false
          if (!followLink(href, currentPath.value, { x: e.clientX, y: e.clientY })) return false
          // Read mode renders a real `<a href>`, and returning true only stops *ProseMirror* —
          // without this the browser follows the href as well and leaves the page.
          e.preventDefault()
          return true
        },
      },
    },
  }),
)


/** The gesture: a modifier while editing, nothing at all while reading. */
function follows(e: MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || readOnly.value
}
