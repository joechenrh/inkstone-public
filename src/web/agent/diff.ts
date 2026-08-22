/**
 * A line diff, for showing what an agent proposes before any of it is accepted.
 *
 * The history panel gets its diffs from git, which is the right source for something that has been
 * committed. A proposal has not been written anywhere — it exists only as a string the binary
 * handed back — so there is nothing for git to compare and the comparison has to happen here.
 *
 * Line-level and not word-level on purpose: the unit a person accepts or rejects is a line, and a
 * word-level diff of a rewritten paragraph is a confetti of fragments that is harder to read than
 * the paragraph.
 */

export type DiffLine =
  | { kind: 'same'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }

/**
 * Above this, the LCS table is skipped and the diff falls back to trimming the common head and
 * tail. 4000×4000 lines is 16M cells — a second of arithmetic and a hundred megabytes for a diff
 * nobody will read line by line. A note that long is not the case worth optimising for; a note that
 * long with a *scattered* rewrite is not a case at all.
 */
const LCS_LIMIT = 4000

/** Rows of context kept around each change. Enough to locate it, not enough to bury it. */
const CONTEXT = 2

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')

  // Identical head and tail come off first. It is what makes the common case cheap — an agent
  // usually rewrites one paragraph or appends one section — and it shrinks the table below.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head
    && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++

  const aMid = a.slice(head, a.length - tail)
  const bMid = b.slice(head, b.length - tail)

  const middle: DiffLine[] = aMid.length * bMid.length > LCS_LIMIT * LCS_LIMIT
    ? [
        ...aMid.map((text): DiffLine => ({ kind: 'del', text })),
        ...bMid.map((text): DiffLine => ({ kind: 'add', text })),
      ]
    : lcsDiff(aMid, bMid)

  return [
    ...a.slice(0, head).map((text): DiffLine => ({ kind: 'same', text })),
    ...middle,
    ...a.slice(a.length - tail).map((text): DiffLine => ({ kind: 'same', text })),
  ]
}

/** Longest common subsequence, walked backwards into a diff. */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((text) => ({ kind: 'add', text }))
  if (m === 0) return a.map((text) => ({ kind: 'del', text }))

  // (n+1)×(m+1) of lengths. One flat array, because a million small arrays is the slow part.
  const table = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] = a[i] === b[j]
        ? table[at(i + 1, j + 1)]! + 1
        : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i]! }); i++; j++ }
    else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) { out.push({ kind: 'del', text: a[i]! }); i++ }
    else { out.push({ kind: 'add', text: b[j]! }); j++ }
  }
  while (i < n) { out.push({ kind: 'del', text: a[i]! }); i++ }
  while (j < m) { out.push({ kind: 'add', text: b[j]! }); j++ }
  return out
}

/** How much changed, for a sentence that can be read without reading the diff. */
export function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') removed++
  }
  return { added, removed }
}

/**
 * Unchanged runs collapsed to a marker, so a one-line change in a long note is one screen rather
 * than a scroll. Returns the same list with long `same` runs replaced by a gap.
 */
export type DiffRow = DiffLine | { kind: 'gap'; hidden: number }

export function collapse(lines: DiffLine[]): DiffRow[] {
  const out: DiffRow[] = []
  let run: DiffLine[] = []

  const flush = (last: boolean) => {
    if (run.length === 0) return
    const first = out.length === 0
    // A run at either end shows context on one side only — there is nothing beyond it to locate.
    const keepTop = first ? 0 : CONTEXT
    const keepBottom = last ? 0 : CONTEXT
    if (run.length <= keepTop + keepBottom + 1) out.push(...run)
    else {
      out.push(...run.slice(0, keepTop))
      out.push({ kind: 'gap', hidden: run.length - keepTop - keepBottom })
      if (keepBottom > 0) out.push(...run.slice(run.length - keepBottom))
    }
    run = []
  }

  for (const line of lines) {
    if (line.kind === 'same') run.push(line)
    else { flush(false); out.push(line) }
  }
  flush(true)
  return out
}
