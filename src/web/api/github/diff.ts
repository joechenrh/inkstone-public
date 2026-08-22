/**
 * A unified diff, computed in the browser.
 *
 * The server gets this from `git diff`. There is no git here, so it is done by hand — and only
 * ever over one note at a time, which is what makes an honest implementation affordable.
 */

export interface LineDiff {
  /** `@@ …` hunks with three lines of context, the shape the commit panel already renders. */
  text: string
  added: number
  removed: number
}

/**
 * Beyond this many edit steps the diff stops being worth computing: the two files have little in
 * common, the panel would show a wall of red and green either way, and Myers' cost grows with
 * exactly this number. Past it, the file is reported as replaced wholesale — which is true.
 */
const MAX_EDIT_DISTANCE = 3000
const CONTEXT = 3

type Op = { kind: 'eq' | 'add' | 'del'; line: string }

export function diffText(before: string, after: string): LineDiff {
  if (before === after) return { text: '', added: 0, removed: 0 }
  const a = splitLines(before)
  const b = splitLines(after)
  const ops = diffLines(a, b)
  return { text: unified(ops), added: count(ops, 'add'), removed: count(ops, 'del') }
}

/** A whole file arriving or leaving, which git renders as every line added or removed. */
export function diffWholeFile(text: string, direction: 'added' | 'deleted'): LineDiff {
  const lines = splitLines(text)
  const kind = direction === 'added' ? 'add' : 'del'
  const ops: Op[] = lines.map((line) => ({ kind, line }))
  return {
    text: unified(ops),
    added: direction === 'added' ? lines.length : 0,
    removed: direction === 'deleted' ? lines.length : 0,
  }
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  // A trailing newline ends the last line rather than starting an empty one.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function count(ops: Op[], kind: Op['kind']): number {
  let n = 0
  for (const op of ops) if (op.kind === kind) n++
  return n
}

/**
 * Myers' diff, with the common prefix and suffix trimmed first — most edits to a note touch one
 * paragraph, and trimming turns those into a search over a handful of lines.
 */
function diffLines(a: string[], b: string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head
    && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)

  const ops: Op[] = a.slice(0, head).map((line) => ({ kind: 'eq' as const, line }))
  ops.push(...middle(midA, midB))
  ops.push(...a.slice(a.length - tail).map((line) => ({ kind: 'eq' as const, line })))
  return ops
}

function middle(a: string[], b: string[]): Op[] {
  if (a.length === 0) return b.map((line) => ({ kind: 'add', line }))
  if (b.length === 0) return a.map((line) => ({ kind: 'del', line }))

  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_EDIT_DISTANCE)
  const v = new Map<number, number>([[1, 0]])
  const trace: Map<number, number>[] = []

  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      const left = v.get(k - 1) ?? 0
      const right = v.get(k + 1) ?? 0
      let x = k === -d || (k !== d && left < right) ? right : left + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v.set(k, x)
      if (x >= n && y >= m) return backtrack(trace, a, b, d)
    }
  }

  // Too far apart to be worth threading a path through.
  return [
    ...a.map((line) => ({ kind: 'del' as const, line })),
    ...b.map((line) => ({ kind: 'add' as const, line })),
  ]
}

function backtrack(trace: Map<number, number>[], a: string[], b: string[], d: number): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length

  for (let step = d; step > 0; step--) {
    const v = trace[step]!
    const k = x - y
    const left = v.get(k - 1) ?? 0
    const right = v.get(k + 1) ?? 0
    const prevK = k === -step || (k !== step && left < right) ? k + 1 : k - 1
    const prevX = v.get(prevK) ?? 0
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) { ops.push({ kind: 'eq', line: a[--x]! }); y-- }
    if (x > prevX) ops.push({ kind: 'del', line: a[--x]! })
    else if (y > prevY) ops.push({ kind: 'add', line: b[--y]! })
  }
  while (x > 0 && y > 0) { ops.push({ kind: 'eq', line: a[--x]! }); y-- }

  return ops.reverse()
}

function unified(ops: Op[]): string {
  // Which ops belong to a hunk: every change, plus CONTEXT lines either side of one.
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach((op, i) => {
    if (op.kind === 'eq') return
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++) keep[j] = true
  })

  const out: string[] = []
  let oldLine = 1
  let newLine = 1
  let i = 0

  while (i < ops.length) {
    if (!keep[i]) {
      if (ops[i]!.kind !== 'add') oldLine++
      if (ops[i]!.kind !== 'del') newLine++
      i++
      continue
    }

    const startOld = oldLine
    const startNew = newLine
    const body: string[] = []
    let oldCount = 0
    let newCount = 0

    while (i < ops.length && keep[i]) {
      const op = ops[i]!
      if (op.kind === 'eq') { body.push(` ${op.line}`); oldCount++; newCount++; oldLine++; newLine++ }
      else if (op.kind === 'del') { body.push(`-${op.line}`); oldCount++; oldLine++ }
      else { body.push(`+${op.line}`); newCount++; newLine++ }
      i++
    }

    out.push(`@@ -${range(startOld, oldCount)} +${range(startNew, newCount)} @@`, ...body)
  }

  return out.join('\n')
}

/** git writes `12` rather than `12,1`, and `0,0` for an empty side. */
function range(start: number, count: number): string {
  if (count === 0) return '0,0'
  return count === 1 ? String(start) : `${start},${count}`
}
