import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

/**
 * Where today's section goes in a note that is kept by date.
 *
 * The decision, with no editor in it: given the date headings a note already has, say whether
 * today is one of them and if not, where it belongs and at what level. The transaction that acts
 * on the answer is in `CrepeEditor`; everything that can be got wrong is here, where a test can
 * reach it without a document.
 */

/** A heading that is nothing but a date, and where it sits among the document's top-level nodes. */
export interface DateHeading {
  /** 1 for `#`, 2 for `##`. */
  level: number
  /** `YYYY-MM-DD`, exactly as the heading spells it. */
  date: string
  /** Index among the document's top-level children. */
  at: number
}

export type TodayPlan =
  /** Today is already in the note: this is where it is. */
  | { found: number }
  /** It is not: insert a heading of `level` before the child at `before`, or at the end for null. */
  | { before: number | null; level: number }

/** A heading whose whole text is a date, which is what this note's days are. */
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function isDateHeading(text: string): boolean {
  return DATE.test(text.trim())
}

/**
 * Today's date where the reader is, not where the server is.
 *
 * `toISOString()` would be the obvious call and it is wrong: it is UTC, so east of Greenwich every
 * evening after 8pm writes yesterday's date, and west of it every morning writes tomorrow's. This
 * project has already shipped one test that passed for exactly that reason.
 */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Where today's section belongs.
 *
 * **The order is read from the note rather than configured.** A journal is written newest-first or
 * oldest-first and the file says which; asking the reader to tell the application a second time is
 * asking them to keep two answers in step. A note whose dates descend gets today at the top; one
 * whose dates ascend gets it at the bottom. Neither is forced, and a note that is reversed later
 * keeps working.
 *
 * The level is read the same way: whatever the note's existing days use. A note with no days yet
 * gets `##`, which is the level under a title.
 */
export function planToday(headings: DateHeading[], today: string): TodayPlan {
  const already = headings.find((one) => one.date === today)
  if (already !== undefined) return { found: already.at }

  const dates = headings.map((one) => one.date)
  const level = headings[0]?.level ?? 2

  if (headings.length === 0) return { before: null, level }

  // Descending unless something says otherwise: a single pair that ascends is enough to settle it,
  // and a note with one day in it is treated as ascending — the common case is a journal that was
  // started at the top of a file and grows downwards.
  const descending = dates.length > 1 && dates.every((date, at) => at === 0 || dates[at - 1]! >= date)

  const next = descending
    ? headings.find((one) => one.date < today)
    : headings.find((one) => one.date > today)
  return { before: next?.at ?? null, level }
}

/**
 * The editor's half: find or make today's section and leave the caret in it.
 *
 * Registered by the editor while it is mounted, because the caret is the point. Going through the
 * `content` signal instead would work and would rebuild the document from markdown — which throws
 * away the selection, and a command whose whole purpose is "ready to type" cannot end by taking
 * the cursor somewhere else.
 */

let runner: ((today?: string) => boolean) | null = null

export function provideToday(next: ((today?: string) => boolean) | null): void {
  runner = next
}

/** False when there is no editor to act on — a note that is not open, or one still loading. */
export function startToday(today?: string): boolean {
  return runner?.(today) ?? false
}

/**
 * Where the caret goes in a section that already exists: the end of its last block.
 *
 * Not the end of the heading — these days are lists, and the end of the last item is where the
 * next line is typed. A section that runs to the end of the note has no following heading to stop
 * at, which is the common case for the newest day.
 */
function endOfSection(doc: ProseNode, at: number, level: number): number {
  let last = at
  doc.forEach((node, _offset, index) => {
    if (index <= at) return
    if (last !== at && index !== last + 1) return
    const isBoundary = node.type.name === 'heading' && (node.attrs.level as number) <= level
    if (isBoundary) return
    last = index
  })
  let end = 0
  doc.forEach((node, offset, index) => {
    if (index === last) end = offset + node.nodeSize - 1
  })
  return end
}

export function applyToday(view: EditorView, today: string = localToday()): boolean {
  const { doc } = view.state
  const headings: DateHeading[] = []
  doc.forEach((node, _offset, index) => {
    if (node.type.name !== 'heading') return
    if (!isDateHeading(node.textContent)) return
    headings.push({ level: node.attrs.level as number, date: node.textContent.trim(), at: index })
  })

  const plan = planToday(headings, today)

  if ('found' in plan) {
    const level = headings.find((one) => one.at === plan.found)?.level ?? 2
    const where = endOfSection(doc, plan.found, level)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, where)).scrollIntoView())
    view.focus()
    return true
  }

  const heading = view.state.schema.nodes.heading
  const paragraph = view.state.schema.nodes.paragraph
  if (heading === undefined || paragraph === undefined) return false

  // Where the insertion lands, in document positions: the start of the child it goes before, or
  // the end of the document.
  let at = doc.content.size
  if (plan.before !== null) {
    doc.forEach((node, offset, index) => {
      if (index === plan.before) at = offset
    })
  }

  const made = [
    heading.create({ level: plan.level }, view.state.schema.text(today)),
    paragraph.create(),
  ]
  const tr = view.state.tr.insert(at, made)
  // Inside the empty paragraph, which is one position past the heading it follows.
  const caret = at + made[0]!.nodeSize + 1
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView())
  view.focus()
  return true
}
