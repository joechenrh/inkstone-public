import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { emphasisSchema, inlineCodeSchema, strongSchema } from '@milkdown/kit/preset/commonmark'
import { strikethroughSchema } from '@milkdown/kit/preset/gfm'
import type { Ctx } from '@milkdown/kit/ctx'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { Fragment, Slice } from '@milkdown/kit/prose/model'
import type { MarkType, Node } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { readOnly } from '../state/settings.js'

/**
 * A run of bold, italic, strikethrough or inline code becomes its own markdown while the caret is
 * in it, and goes back to being bold, italic, struck out or code when the caret leaves — the way
 * `source-reveal.ts` already does it for a link, and the way Typora and the previous engine do it
 * for everything.
 *
 * **The version this replaces drew the markers as widget decorations**, which looked identical and
 * was not the same thing, in a way that took three rounds of reports to pin down. A widget is not
 * text, so:
 *
 * - The caret could not be put on both sides of one. Measured: ProseMirror maps a document position
 *   to a single DOM point, and a widget's `side` only decides where the widget sits in the DOM
 *   around it — so "inside the closing backtick" and "after it" are one position with one caret,
 *   and no arrangement of sides makes them look different. The end of `` `a` `` could be arrived at
 *   but never *seen*, and what was typed there went somewhere the caret was not.
 * - A mouse could not reach the position at all: a click resolves to the position and nothing
 *   carries which side of the marker it meant.
 * - Backspace could not take a marker out, so there was no way to unbold text by deleting its
 *   asterisks, which is how anyone who writes markdown unbolds text.
 *
 * Every one of those is the same missing property: *the syntax was not in the document*. So now it
 * is. The characters are inserted wearing the mark itself, which is why an open run still looks
 * bold — Typora shows `**bold**` in bold — and why what is typed inside it is part of the run.
 *
 * **The cost, stated plainly**, is `source-reveal.ts`'s cost: while a run is open the document
 * holds literal `*` characters, and a markdown serialiser escapes those. `collapseMarks` is
 * therefore called before every save and on every blur, and nothing may read this document for
 * keeps while a run is open.
 *
 * Neither opening nor closing goes into the undo history: they are the same run in two
 * presentations, and stepping through them with Ctrl+Z would undo something nobody did.
 */

interface Open {
  /** The whole span, syntax included, mapped forward as the reader types inside it. */
  from: number
  to: number
  syntax: string
  /** The mark's type name, which is all that has to survive a transaction. */
  mark: string
}

const KEY = new PluginKey<Open | null>('inkstoneMarkReveal')

/** What each mark is spelled with. Emphasis is `*`, matching what the serialiser writes. */
const MARKS: { schema: { type: (ctx: Ctx) => MarkType }; syntax: string }[] = [
  { schema: strongSchema, syntax: '**' },
  { schema: emphasisSchema, syntax: '*' },
  { schema: strikethroughSchema, syntax: '~~' },
  { schema: inlineCodeSchema, syntax: '`' },
]

function typeOf(name: string, ctx: Ctx): MarkType | null {
  for (const { schema } of MARKS) {
    const type = schema.type(ctx)
    if (type.name === name) return type
  }
  return null
}

/**
 * The same content with the open run's markers taken out of it, for anything leaving the editor.
 *
 * While a run is open the document really does hold `**aa**`, and the markers wear the mark
 * themselves — that is what makes an open run look like what it is. Copied, that went to the
 * clipboard as `<strong>**aa**</strong>`, and pasting it back gave a bold run whose text was
 * `**aa**`, which the serialiser wrapped again: `****aa****`. Reported.
 *
 * Only the markers go. The mark stays, so bold copied out of the editor is still bold when it comes
 * back, and `text/plain` is the `**aa**` anybody pasting into a terminal would want.
 */
function withoutMarkers(fragment: Fragment, ctx: Ctx): Fragment {
  const out: Node[] = []
  fragment.forEach((child) => {
    if (!child.isText || child.text === undefined) {
      out.push(child.copy(withoutMarkers(child.content, ctx)))
      return
    }
    const worn = MARKS.find(({ schema }) => schema.type(ctx).isInSet(child.marks))
    if (worn === undefined) {
      out.push(child)
      return
    }
    let text = child.text
    const len = worn.syntax.length
    // Each end on its own: a partial selection carries one marker and not the other.
    if (text.startsWith(worn.syntax)) text = text.slice(len)
    if (text.endsWith(worn.syntax)) text = text.slice(0, -len)
    if (text !== '') out.push(child.type.schema.text(text, child.marks))
  })
  return Fragment.fromArray(out)
}

/**
 * The run the caret is in, ends included — `|`a`` and `` `a`| `` are both in it.
 *
 * The *smallest* one, when they nest: in `**a *b* c**` the caret in `b` is in two runs, and the one
 * it is in is the italic. Collected as spans first and chosen afterwards, because `Fragment.forEach`
 * has no way to stop early.
 */
function runAt(doc: Node, pos: number, ctx: Ctx): Open | null {
  const $from = doc.resolve(pos)
  if (!$from.parent.isTextblock) return null

  let best: Open | null = null
  for (const { schema, syntax } of MARKS) {
    const type = schema.type(ctx)
    const runs: { from: number; to: number }[] = []
    let pos = $from.start()
    $from.parent.forEach((child) => {
      const at = pos
      pos += child.nodeSize
      if (!child.isText || !type.isInSet(child.marks)) return
      const last = runs[runs.length - 1]
      if (last && last.to === at) last.to = pos
      else runs.push({ from: at, to: pos })
    })
    const run = runs.find((r) => $from.pos >= r.from && $from.pos <= r.to)
    if (!run) continue
    if (best === null || run.to - run.from < best.to - best.from) {
      best = { from: run.from, to: run.to, syntax, mark: type.name }
    }
  }
  return best
}

/**
 * Turn an open run's text back into a mark, on the transaction given.
 *
 * If the syntax at its ends is no longer there the whole span is left as plain text. That is not a
 * failure case — it is how emphasis is removed: take out an asterisk and what stays is what you
 * typed, which is what every markdown editor does and what decorations could not do.
 *
 * The mark is applied across everything between the markers rather than left where it was, so text
 * typed against the inside of a marker belongs to the run whatever ProseMirror's inclusivity rules
 * would have said about that position.
 */
function intact(doc: Node, open: Open): boolean {
  const text = doc.textBetween(open.from, open.to, '', '')
  const len = open.syntax.length
  return text.startsWith(open.syntax) && text.endsWith(open.syntax) && text.length > 2 * len
}

function collapse(tr: Transaction, open: Open, ctx: Ctx): Transaction {
  const type = typeOf(open.mark, ctx)
  const done = (t: Transaction) => t.setMeta(KEY, null).setMeta('addToHistory', false)
  if (type === null) return done(tr)

  const len = open.syntax.length
  if (!intact(tr.doc, open)) {
    tr.removeMark(open.from, open.to, type)
    return done(tr)
  }
  // The closing marker first: taking the opening one out would move it.
  tr.delete(open.to - len, open.to)
  tr.delete(open.from, open.from + len)
  tr.addMark(open.from, open.to - 2 * len, type.create())
  return done(tr)
}

/**
 * Close whatever is open, now, from outside the plugin.
 *
 * The editor calls this before it splits a line and when the document loses focus.
 */
export function collapseMarks(view: EditorView, ctx: Ctx): void {
  const open = KEY.getState(view.state)
  if (!open) return
  view.dispatch(collapse(view.state.tr, open, ctx))
}

/**
 * The document as it would be with nothing open — without changing what is on screen.
 *
 * Closing before a save was never enough on its own. The open form reaches `content` through the
 * editor's own update as it is typed, and from there it reaches the draft in local storage, the
 * text a commit reads, and the source view — so a stray `` ` `` could turn up in a note without
 * anyone having saved while a run was open. What is *read* is collapsed instead of what is shown,
 * which leaves nothing to remember to do.
 */
export function closeMarksOn(state: EditorState, tr: Transaction, ctx: Ctx): Transaction {
  const open = KEY.getState(state)
  if (!open) return tr
  // Mapped, because something else may have been closed on this transaction already.
  return collapse(tr, { ...open, from: tr.mapping.map(open.from, 1), to: tr.mapping.map(open.to, -1) }, ctx)
}

/** Whether anything is open, so the reader can skip the work when nothing is. */
export function marksAreOpen(state: EditorState): boolean {
  return KEY.getState(state) != null
}

/**
 * Open the run at `pos`, on the transaction given.
 *
 * Takes a transaction rather than a state because closing one run and opening the next have to
 * happen together: moving the caret straight from `**bold**` into `` `code` `` is one selection
 * change, and a version that only closed left the second run shut until something else moved.
 */
function openAt(tr: Transaction, pos: number, ctx: Ctx): Transaction {
  const run = runAt(tr.doc, pos, ctx)
  if (run === null) return tr
  const type = typeOf(run.mark, ctx)
  if (type === null) return tr

  const len = run.syntax.length
  // The markers wear the mark themselves, so an open run still looks like what it is.
  const marker = tr.doc.type.schema.text(run.syntax, [type.create()])
  tr.insert(run.to, marker).insert(run.from, marker)

  // Where the caret was, in the text — and on the same side of the run it was already on.
  const caret = pos === run.from ? run.from
    : pos === run.to ? run.to + 2 * len
      : pos + len
  return tr
    .setSelection(TextSelection.create(tr.doc, caret))
    .setMeta(KEY, { from: run.from, to: run.to + 2 * len, syntax: run.syntax, mark: run.mark })
    .setMeta('addToHistory', false)
}

/**
 * A complete piece of syntax the reader typed *around* their text rather than into it.
 *
 * `**bold**` typed left to right is turned into a mark by an input rule, on the last asterisk. Typed
 * the other way round — the four stars first, the word after — no rule ever fires: an input rule
 * matches what is behind the caret, and the closing pair is in front of it. So the text sat there
 * as four literal asterisks for ever, which is what was reported.
 *
 * What comes back is the run as {@link Open} describes one, *including* its markers, so the caller
 * can put the mark on it and record it as open. Nothing about the screen changes at that moment —
 * an open run wears its own markers — and the collapse that happens when the caret leaves is the
 * one that has always been there.
 */
const AROUND: { syntax: string; pattern: RegExp }[] = [
  // Longest first: `**a**` is strong, not emphasis wrapped in stray asterisks.
  { syntax: '**', pattern: /\*\*([^*\n]+)\*\*/g },
  { syntax: '~~', pattern: /~~([^~\n]+)~~/g },
  { syntax: '*', pattern: /(?<!\*)\*([^*\n]+)\*(?!\*)/g },
  { syntax: '`', pattern: /`([^`\n]+)`/g },
]

function typedAround(state: EditorState, ctx: Ctx): Open | null {
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.isTextblock) return null
  const start = $from.start()
  const text = $from.parent.textBetween(0, $from.parent.content.size, '\n', '\n')
  const caret = $from.pos - start

  for (const { syntax, pattern } of AROUND) {
    const mark = MARKS.find((m) => m.syntax === syntax)
    if (mark === undefined) continue
    const type = mark.schema.type(ctx)
    pattern.lastIndex = 0
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      const from = start + m.index
      const to = from + m[0].length
      /*
       * In the text between the markers, its ends included.
       *
       * Both ends count: the caret sits right after the last letter typed, which is exactly the end
       * of the inner text — measured, and the first version of this test excluded precisely the
       * position every reader is in when the pair closes. Outside the markers does not count:
       * typing past the closing pair is finishing with the run, not writing in it.
       */
      if ($from.pos < from + syntax.length || $from.pos > to - syntax.length) continue
      // Already a mark of this kind — `runAt` handles those, and it looked first.
      if (type.isInSet(state.doc.resolve(from + syntax.length + 1).marks())) continue
      // Inside code, the asterisks are the text. Nothing in a code span is emphasis.
      const codeType = inlineCodeSchema.type(ctx)
      if (syntax !== '`' && codeType.isInSet(state.doc.resolve(from + syntax.length + 1).marks())) continue
      return { from, to, syntax, mark: type.name }
    }
  }
  return null
}

/** Whether the run was already marked before this round of transactions. */
function existedBefore(run: Open, trs: readonly Transaction[], old: EditorState, ctx: Ctx): boolean {
  const type = typeOf(run.mark, ctx)
  if (type === null) return false
  let from = run.from
  let to = run.to
  for (let i = trs.length - 1; i >= 0; i--) {
    const back = trs[i]?.mapping.invert()
    if (back === undefined) return false
    from = back.map(from, 1)
    to = back.map(to, -1)
  }
  if (to <= from || to > old.doc.content.size) return false
  return old.doc.rangeHasMark(from, to, type)
}

export const markReveal = $prose((ctx) =>
  new Plugin<Open | null>({
    key: KEY,
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(KEY) as Open | null | undefined
        if (meta !== undefined) return meta
        if (!value) return null
        // The edges hold still while the middle is typed in: text put in *at* a marker is outside
        // the run, which is what makes a character typed after the closing one plain.
        const from = tr.mapping.map(value.from, 1)
        const to = tr.mapping.map(value.to, -1)
        return to > from ? { ...value, from, to } : null
      },
    },
    appendTransaction(trs, old, state) {
      const open = KEY.getState(state)
      if (open) {
        const { from, to } = state.selection
        /*
         * Still inside, and still spelled the way it was: leave it open, whatever is being typed.
         *
         * The second half is not the same as the first. Taking a backtick out of `` `aaa` `` makes
         * it not code any more, and waiting for the caret to leave before saying so meant the text
         * stayed in a code chip that the document no longer had any reason to draw — reported as
         * "it only goes back to plain text after the focus moves". A marker is the thing that makes
         * a run, so the moment one is gone the run is over.
         */
        if (from >= open.from && to <= open.to && !readOnly.value && intact(state.doc, open)) return null
        const tr = collapse(state.tr, open, ctx)
        // …and straight into the next one, if that is where the caret went.
        if (readOnly.value || !state.selection.empty) return tr
        return openAt(tr, tr.mapping.map(from), ctx)
      }

      // A close that has just happened is not an invitation to open again: the caret is still in
      // the run it was closed on.
      if (trs.some((tr) => tr.getMeta(KEY) === null)) return null
      // Reading, not editing.
      if (readOnly.value) return null
      if (!state.selection.empty) return null

      const run = runAt(state.doc, state.selection.from, ctx)
      if (run === null) {
        /*
         * Nothing marked here — but the reader may have just closed a pair around their own text.
         *
         * Only on a round that changed the document. Asterisks that were already sitting in a note
         * are somebody's literal asterisks, escaped in the file as `\*\*`, and walking a caret
         * through them must not quietly turn them into emphasis.
         */
        if (!trs.some((tr) => tr.docChanged)) return null
        const typed = typedAround(state, ctx)
        if (typed === null) return null
        const type = typeOf(typed.mark, ctx)
        if (type === null) return null
        // The markers wear the mark too, which is what an open run looks like — so the screen does
        // not change now, and the collapse when the caret leaves is the usual one.
        return state.tr
          .addMark(typed.from, typed.to, type.create())
          .setMeta(KEY, typed)
          .setMeta('addToHistory', false)
      }
      /*
       * A run that was *just made* is not one to open.
       *
       * Typing `**b**` makes one under a caret that never moved, and spelling it straight back out
       * would make the bold look like it had never happened. The first version of this guard
       * refused to open on *any* change to the document, which was too much: backspacing from the
       * end of `` `aaa`111 `` walks the caret into a run that has been there all along, and with
       * the guard in the way it never opened — so the backticks were never real characters, and
       * the deletion went straight past them and ate the text instead. Reported as "the backtick
       * is skipped and it does not expand".
       *
       * So the question is about this run rather than about the document: was it here before? Its
       * range is mapped back through the round and asked of the state as it was.
       */
      if (trs.some((tr) => tr.docChanged) && !existedBefore(run, trs, old, ctx)) return null

      const tr = openAt(state.tr, state.selection.from, ctx)
      return tr.getMeta(KEY) === undefined ? null : tr
    },
    props: {
      handleDOMEvents: {
        // Focus leaving the document closes the run, so nothing else ever sees the escaped form.
        blur: (view) => { collapseMarks(view, ctx); return false },
      },

      /*
       * What leaves on the clipboard is the closed form.
       *
       * Only while something is open — with nothing revealed there are no markers in the document
       * to mistake for text, and a copy should pass through untouched.
       */
      transformCopied(slice, view) {
        if (KEY.getState(view.state) == null) return slice
        return new Slice(withoutMarkers(slice.content, ctx), slice.openStart, slice.openEnd)
      },
    },
  }),
)
