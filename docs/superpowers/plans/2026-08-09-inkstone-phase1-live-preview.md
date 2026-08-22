# Inkstone Phase 1: Live Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** every Phase 0 completion criterion has passed. This plan assumes `createExtensions()` in `src/web/editor/setup.ts` already exists and works.

**Goal:** Turn the plain-source editor into a Typora-style hybrid live preview — anywhere the cursor is not, the text renders as typeset output; the moment the cursor lands, the raw markdown syntax is revealed.

**Architecture:** Every rendering is a CodeMirror decoration derived from the Lezer syntax tree plus the selection position; the document itself is always raw markdown. Two layers: the block layer comes from a `StateField` (which can replace across lines and insert widgets with height), and the inline layer from a `ViewPlugin` (which handles only the lines in the viewport, hiding marker characters and adding CSS classes). Both layers share one "skip when the selection overlaps the node" predicate.

**Tech Stack:** CodeMirror 6 (`@codemirror/language`, `@lezer/common`), KaTeX, Mermaid, and Shiki or `@codemirror/language-data`.

## Global Constraints

- **The document is never rewritten by decorations.** No extension may `dispatch` a document change on the render path. The only thing allowed to change the document is Task 11's input-feel keymap, and only in response to a user keystroke.
- **Block replacements must come from a `StateField`.** Decorations provided by a `ViewPlugin` run after viewport measurement, and replacing across lines there corrupts height calculation. This is not a style preference; it is a hard CM6 constraint.
- Each extension exports one `Extension`, assembled in a fixed order inside `createExtensions()`. **Do not** cram several syntax constructs into one extension.
- One test file per extension, constructing an `EditorState` and asserting the decoration set. **No browser** — `EditorState` is a pure data structure.
- All colors reference variables from `tokens.css`; extensions never hard-code color values.
- The cursor reveal rule: inline nodes are decided per node, block widgets per whole block.
- Any decorated range must also go into `atomicRanges`, or arrow keys will walk into the hidden marker characters.

---

### Task 1: Live-preview groundwork

This task produces no visible effect; it produces the foundation the next ten tasks share. It stands alone because getting these interfaces wrong means reworking every extension that follows.

**Files:**
- Create: `src/web/editor/live/shared.ts`
- Create: `src/web/editor/live/testing.ts` (test helpers, test-only)
- Test: `tests/web/editor/shared.test.ts`

**Interfaces:**
- Consumes: `@codemirror/state`、`@codemirror/view`、`@codemirror/language`
- Produces:

```ts
// src/web/editor/live/shared.ts
import type { EditorState, Range } from '@codemirror/state'
import type { Decoration } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'

/** Whether the selection (including every cursor in a multi-cursor) overlaps [from, to]. Overlap means "the cursor is here" and the source should be revealed. */
export function selectionTouches(state: EditorState, from: number, to: number): boolean

/** Whether the whole block containing this node (its nearest block-level ancestor) is touched by the selection. */
export function selectionTouchesBlock(state: EditorState, node: SyntaxNodeRef): boolean

/** The zero-width replacement decoration used to hide marker characters. A single shared instance, to avoid repeated allocation. */
export const hideMark: Decoration

/** Walks the syntax tree within the given range, calling visit for each node. */
export function iterateTree(
  state: EditorState,
  from: number,
  to: number,
  visit: (node: SyntaxNodeRef) => void,
): void

/** Sorts a Range<Decoration>[] and builds a DecorationSet. CM6 requires the input to be ordered. */
export function buildSet(ranges: Array<Range<Decoration>>): DecorationSet
```

```ts
// src/web/editor/live/testing.ts
/** Constructs an EditorState with extensions and a cursor position. A `|` in doc marks the cursor and is stripped. */
export function stateWithCursor(doc: string, extensions: Extension[]): EditorState

/** Extracts every decoration produced by a given ViewPlugin/StateField, converted into plain assertable objects. */
export interface DecoInfo {
  from: number
  to: number
  kind: 'mark' | 'replace' | 'line' | 'widget'
  class?: string
  widget?: string
}
export function readDecorations(view: EditorView): DecoInfo[]
```

- [ ] **Step 1: Install the dependencies**

```bash
pnpm add @lezer/common @lezer/markdown @lezer/highlight @codemirror/language-data
```

- [ ] **Step 2: Write the failing shared test**

`tests/web/editor/shared.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { describe, expect, it } from 'vitest'
import { selectionTouches, selectionTouchesBlock } from '../../../src/web/editor/live/shared.js'

function stateAt(doc: string, ...cursors: number[]): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown()],
    selection: EditorSelection.create(cursors.map((c) => EditorSelection.cursor(c))),
  })
}

describe('selectionTouches', () => {
  const doc = 'hello **bold** world'
  //           0123456789...
  //           ** spans 6 to 8, bold spans 8 to 12, the closing ** spans 12 to 14

  it('returns true when the cursor is inside the range', () => {
    expect(selectionTouches(stateAt(doc, 10), 6, 14)).toBe(true)
  })

  it('returns true when the cursor is at the start of the range', () => {
    expect(selectionTouches(stateAt(doc, 6), 6, 14)).toBe(true)
  })

  it('returns true when the cursor is at the end of the range', () => {
    expect(selectionTouches(stateAt(doc, 14), 6, 14)).toBe(true)
  })

  it('returns false when the cursor is outside the range', () => {
    expect(selectionTouches(stateAt(doc, 2), 6, 14)).toBe(false)
    expect(selectionTouches(stateAt(doc, 18), 6, 14)).toBe(false)
  })

  it('true when any one of several cursors hits', () => {
    expect(selectionTouches(stateAt(doc, 2, 10), 6, 14)).toBe(true)
  })

  it('returns true when the selection spans the whole range', () => {
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: EditorSelection.single(0, 20),
    })
    expect(selectionTouches(state, 6, 14)).toBe(true)
  })

  it('returns false when the selection is entirely outside the range', () => {
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: EditorSelection.single(0, 4),
    })
    expect(selectionTouches(state, 6, 14)).toBe(false)
  })
})

describe('selectionTouchesBlock', () => {
  const doc = '# heading\n\nparagraph text\n\n$$\nx = 1\n$$\n'

  function firstNodeOfType(state: EditorState, type: string) {
    let found: ReturnType<typeof syntaxTree>['topNode'] | null = null
    syntaxTree(state).iterate({
      enter: (node) => {
        if (!found && node.name === type) found = node.node
      },
    })
    if (!found) throw new Error(`node ${type} not found`)
    return found
  }

  it('returns true when the cursor is in the same block', () => {
    const state = stateAt(doc, 3)
    expect(selectionTouchesBlock(state, firstNodeOfType(state, 'ATXHeading1'))).toBe(true)
  })

  it('returns false when the cursor is in another block', () => {
    const state = stateAt(doc, 15)
    expect(selectionTouchesBlock(state, firstNodeOfType(state, 'ATXHeading1'))).toBe(false)
  })

  it('returns true when the cursor is on the block\'s last character', () => {
    const state = stateAt(doc, 9)
    expect(selectionTouchesBlock(state, firstNodeOfType(state, 'ATXHeading1'))).toBe(true)
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/editor/shared.test.ts`
Expected: FAIL, `src/web/editor/live/shared.ts` does not exist

- [ ] **Step 4: Implement shared.ts**

```ts
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, type EditorState, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'

/**
 * Whether the selection (including every cursor in a multi-cursor) overlaps [from, to].
 * Endpoints count as overlap: a cursor resting on the left edge of `**` clearly means the user wants to edit it.
 */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true
  }
  return false
}

/** The node names that constitute a "block" in Lezer markdown. */
const BLOCK_NODES = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
  'Paragraph',
  'FencedCode',
  'CodeBlock',
  'Blockquote',
  'BulletList',
  'OrderedList',
  'ListItem',
  'Table',
  'HorizontalRule',
  'HTMLBlock',
])

/**
 * Whether this node's nearest block-level ancestor is touched by the selection.
 * Block widgets use it to decide: a cursor anywhere inside a $$ block turns the whole block back into source.
 */
export function selectionTouchesBlock(state: EditorState, node: SyntaxNodeRef): boolean {
  let current = node.node
  while (current.parent && !BLOCK_NODES.has(current.name)) {
    current = current.parent
  }
  return selectionTouches(state, current.from, current.to)
}

/** The zero-width replacement used to hide marker characters. A shared singleton, to avoid reallocating every frame. */
export const hideMark = Decoration.replace({})

export function iterateTree(
  state: EditorState,
  from: number,
  to: number,
  visit: (node: SyntaxNodeRef) => void,
): void {
  syntaxTree(state).iterate({ from, to, enter: visit })
}

/** CM6 requires decorations sorted by from ascending, and by startSide ascending within the same from. */
export function buildSet(ranges: Array<Range<Decoration>>): DecorationSet {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
  const builder = new RangeSetBuilder<Decoration>()
  for (const range of sorted) {
    builder.add(range.from, range.to, range.value)
  }
  return builder.finish()
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/editor/shared.test.ts`
Expected: PASS, all 10 cases green

- [ ] **Step 6: Implement the testing.ts helpers**

Every later extension's tests depend on this; getting it right once saves ten repeats.

```ts
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

/**
 * Constructs an EditorState with a cursor. A `|` in doc marks the cursor position and is stripped.
 * With no `|`, the cursor goes to position 0, outside the end of the document (guaranteeing it touches nothing).
 */
export function stateWithCursor(doc: string, extensions: Extension[]): EditorState {
  const cursor = doc.indexOf('|')
  const clean = cursor >= 0 ? doc.slice(0, cursor) + doc.slice(cursor + 1) : doc
  return EditorState.create({
    doc: clean,
    extensions,
    selection: EditorSelection.cursor(cursor >= 0 ? cursor : 0),
  })
}

export interface DecoInfo {
  from: number
  to: number
  kind: 'mark' | 'replace' | 'line' | 'widget'
  class?: string
  widget?: string
}

function classifyDecoration(deco: Decoration): DecoInfo['kind'] {
  const spec = deco.spec as Record<string, unknown>
  if (spec.widget !== undefined) return deco.startSide < 0 ? 'widget' : 'replace'
  if (spec.class !== undefined && deco.startSide < 0) return 'line'
  return spec.class !== undefined ? 'mark' : 'replace'
}

/**
 * Collects the decorations provided by every facet on the view and flattens them into plain assertable objects.
 * Covers both StateField and ViewPlugin sources.
 */
export function readDecorations(view: EditorView): DecoInfo[] {
  const out: DecoInfo[] = []
  const sets: DecorationSet[] = []

  for (const provider of view.state.facet(EditorView.decorations)) {
    sets.push(typeof provider === 'function' ? provider(view) : provider)
  }

  for (const set of sets) {
    const iter = set.iter()
    while (iter.value) {
      const spec = iter.value.spec as { class?: string; widget?: { toString?: () => string } }
      out.push({
        from: iter.from,
        to: iter.to,
        kind: classifyDecoration(iter.value),
        ...(spec.class ? { class: spec.class } : {}),
        ...(spec.widget ? { widget: spec.widget.constructor.name } : {}),
      })
      iter.next()
    }
  }

  return out.sort((a, b) => a.from - b.from || a.to - b.to)
}

/** Mounts a view in jsdom and destroys it after the callback. */
export function withView<T>(state: EditorState, fn: (view: EditorView) => T): T {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({ state, parent })
  try {
    return fn(view)
  } finally {
    view.destroy()
    parent.remove()
  }
}
```

- [ ] **Step 7: Verify testing.ts itself works, with a minimal extension**

`tests/web/editor/testing.test.ts`：

```ts
import { EditorView } from '@codemirror/view'
import { Decoration } from '@codemirror/view'
import { StateField } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { readDecorations, stateWithCursor, withView } from '../../../src/web/editor/live/testing.js'
import { buildSet } from '../../../src/web/editor/live/shared.js'

// a minimal extension marking the document's first 3 characters with test-class
const probe = StateField.define({
  create: () => buildSet([{ from: 0, to: 3, value: Decoration.mark({ class: 'test-class' }) }]),
  update: (value) => value,
  provide: (f) => EditorView.decorations.from(f),
})

describe('testing helpers', () => {
  it('stateWithCursor strips | and sets the cursor', () => {
    const state = stateWithCursor('abc|def', [])
    expect(state.doc.toString()).toBe('abcdef')
    expect(state.selection.main.head).toBe(3)
  })

  it('the cursor is at 0 when there is no |', () => {
    expect(stateWithCursor('abcdef', []).selection.main.head).toBe(0)
  })

  it('readDecorations reads decorations provided by a StateField', () => {
    const state = stateWithCursor('abcdef', [probe])
    const decos = withView(state, (view) => readDecorations(view))
    expect(decos).toEqual([{ from: 0, to: 3, kind: 'mark', class: 'test-class' }])
  })
})
```

Run: `pnpm vitest run tests/web/editor/testing.test.ts`
Expected: PASS, all 3 cases green

If `readDecorations` cannot see the decorations, it is most likely reading the `EditorView.decorations` facet the wrong way — fix `testing.ts` before moving on, because the next ten tasks all depend on it.

- [ ] **Step 8: Commit**

```bash
git add package.json src/web/editor/live tests/web/editor
git commit -m "feat(editor): add live preview foundations and decoration test harness"
```

---

### Task 2: The inline layer — emphasis, inline code, strikethrough

**Files:**
- Create: `src/web/editor/live/inline.ts`
- Create: `src/web/editor/live/inline.css`
- Test: `tests/web/editor/inline.test.ts`

**Interfaces:**
- Consumes: `selectionTouches`、`hideMark`、`buildSet`（Task 1）
- Produces: `export function inlineDecorations(): Extension`

Nodes handled, and what they produce:

| Lezer node | Marker child | Class added to the content |
|---|---|---|
| `StrongEmphasis` | `EmphasisMark` (`**` or `__`) | `ink-strong` |
| `Emphasis` | `EmphasisMark` (`*` or `_`) | `ink-em` |
| `Strikethrough` | `StrikethroughMark`（`~~`） | `ink-strike` |
| `InlineCode` | `CodeMark`（`` ` ``） | `ink-code` |

- [ ] **Step 1: Write the failing inline tests**

`tests/web/editor/inline.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { inlineDecorations } from '../../../src/web/editor/live/inline.js'
import { readDecorations, stateWithCursor, withView } from '../../../src/web/editor/live/testing.js'

const EXT = [markdown(), inlineDecorations()]

function decosFor(doc: string) {
  return withView(stateWithCursor(doc, EXT), (view) => readDecorations(view))
}

describe('bold', () => {
  it('hides ** and adds a class to the content when the cursor is elsewhere', () => {
    // 'a **bold** b'  →  ** spans [2,4) and [8,10), bold spans [4,8)
    const decos = decosFor('|a **bold** b')
    expect(decos).toContainEqual({ from: 2, to: 4, kind: 'replace' })
    expect(decos).toContainEqual({ from: 8, to: 10, kind: 'replace' })
    expect(decos).toContainEqual({ from: 4, to: 8, kind: 'mark', class: 'ink-strong' })
  })

  it('does not hide the markers when the cursor is inside the node', () => {
    const decos = decosFor('a **bo|ld** b')
    expect(decos.some((d) => d.kind === 'replace')).toBe(false)
  })

  it('keeps the content style class even when the cursor is inside the node', () => {
    const decos = decosFor('a **bo|ld** b')
    expect(decos).toContainEqual({ from: 4, to: 8, kind: 'mark', class: 'ink-strong' })
  })

  it('a cursor immediately outside the left marker still counts as touching', () => {
    const decos = decosFor('a |**bold** b')
    expect(decos.some((d) => d.kind === 'replace')).toBe(false)
  })

  it('two bold runs on the same line do not affect each other', () => {
    // 'x **a** y **b** z' → the first spans [2,9), the second [12,19)
    const decos = decosFor('x **a|** y **b** z')
    const replaced = decos.filter((d) => d.kind === 'replace')
    // only the second run's two markers are hidden
    expect(replaced).toHaveLength(2)
    expect(replaced.every((d) => d.from >= 10)).toBe(true)
  })

  it('the __ syntax works too', () => {
    const decos = decosFor('|a __bold__ b')
    expect(decos).toContainEqual({ from: 4, to: 8, kind: 'mark', class: 'ink-strong' })
  })
})

describe('italic', () => {
  it('hides a single * and adds ink-em', () => {
    const decos = decosFor('|a *em* b')
    expect(decos).toContainEqual({ from: 2, to: 3, kind: 'replace' })
    expect(decos).toContainEqual({ from: 3, to: 5, kind: 'mark', class: 'ink-em' })
    expect(decos).toContainEqual({ from: 5, to: 6, kind: 'replace' })
  })

  it('bold with nested italic carries both classes', () => {
    const decos = decosFor('|***both***')
    const classes = decos.filter((d) => d.kind === 'mark').map((d) => d.class)
    expect(classes).toContain('ink-strong')
    expect(classes).toContain('ink-em')
  })
})

describe('inline code', () => {
  it('hides the backticks and adds ink-code', () => {
    const decos = decosFor('|a `code` b')
    expect(decos).toContainEqual({ from: 2, to: 3, kind: 'replace' })
    expect(decos).toContainEqual({ from: 3, to: 7, kind: 'mark', class: 'ink-code' })
  })

  it('reveals the backticks when the cursor enters', () => {
    const decos = decosFor('a `co|de` b')
    expect(decos.some((d) => d.kind === 'replace')).toBe(false)
  })
})

describe('strikethrough', () => {
  it('hides ~~ and adds ink-strike', () => {
    const decos = decosFor('|a ~~gone~~ b')
    expect(decos).toContainEqual({ from: 4, to: 8, kind: 'mark', class: 'ink-strike' })
    expect(decos.filter((d) => d.kind === 'replace')).toHaveLength(2)
  })
})

describe('no false positives', () => {
  it('plain text produces no decorations', () => {
    expect(decosFor('|just plain text')).toEqual([])
  })

  it('asterisks inside a code block are not treated as emphasis', () => {
    const decos = decosFor('|```\n**not bold**\n```')
    expect(decos).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/editor/inline.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement inline.ts**

```ts
import type { Extension, Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import { buildSet, hideMark, iterateTree, selectionTouches } from './shared.js'

/** Node name → content style class. The keys are exactly the Lezer nodes to handle. */
const INLINE_STYLES: Record<string, string> = {
  StrongEmphasis: 'ink-strong',
  Emphasis: 'ink-em',
  Strikethrough: 'ink-strike',
  InlineCode: 'ink-code',
}

/** The names of the "marker character" child nodes inside each node. */
const MARK_NODES = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark'])

const MARK_DECORATIONS = new Map(
  Object.entries(INLINE_STYLES).map(([node, cls]) => [node, Decoration.mark({ class: cls })]),
)

function collect(view: EditorView): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  const state = view.state

  for (const { from, to } of view.visibleRanges) {
    iterateTree(state, from, to, (node: SyntaxNodeRef) => {
      const style = MARK_DECORATIONS.get(node.name)
      if (!style) return

      const touched = selectionTouches(state, node.from, node.to)

      // the content style is always kept: entering with the cursor only reveals the marker characters, and should not make the text style jump
      const marks = childMarks(node)
      const contentFrom = marks.length > 0 ? marks[0]!.to : node.from
      const contentTo = marks.length > 1 ? marks[marks.length - 1]!.from : node.to
      if (contentTo > contentFrom) {
        ranges.push(style.range(contentFrom, contentTo))
      }

      if (touched) return
      for (const mark of marks) {
        ranges.push(hideMark.range(mark.from, mark.to))
      }
    })
  }

  return buildSet(ranges)
}

function childMarks(node: SyntaxNodeRef): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = []
  let child = node.node.firstChild
  while (child) {
    if (MARK_NODES.has(child.name)) out.push({ from: child.from, to: child.to })
    child = child.nextSibling
  }
  return out
}

const inlinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = collect(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = collect(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/**
 * atomicRanges covers only the hidden marker characters, so arrow keys step over them in one move.
 * The mark decoration on the content must not be atomic — that would stop the cursor entering the bold text.
 */
const inlineAtomic = EditorView.atomicRanges.of((view) => {
  const plugin = view.plugin(inlinePlugin)
  if (!plugin) return Decoration.none
  const hidden: Array<Range<Decoration>> = []
  const iter = plugin.decorations.iter()
  while (iter.value) {
    if ((iter.value.spec as { class?: string }).class === undefined) {
      hidden.push(hideMark.range(iter.from, iter.to))
    }
    iter.next()
  }
  return buildSet(hidden)
})

export function inlineDecorations(): Extension {
  return [inlinePlugin, inlineAtomic]
}
```

`atomicRanges` has to be written as a standalone facet rather than passed as the second argument to `ViewPlugin.fromClass` — the latter's `provide` callback cannot reference the not-yet-initialized plugin instance itself.

- [ ] **Step 4: Write inline.css**

```css
.ink-strong {
  font-weight: 600;
}

.ink-em {
  font-style: italic;
}

.ink-strike {
  text-decoration: line-through;
  color: var(--ink-fg-muted);
}

.ink-code {
  font-family: var(--ink-font-mono);
  font-size: 0.92em;
  background: var(--ink-code-bg);
  padding: 0.15em 0.3em;
  border-radius: 3px;
}
```

The 3px radius on `.ink-code` is the only rounded corner the whole application permits (see the design document's "three disciplines").

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/editor/inline.test.ts`
Expected: PASS, all 13 cases green

If the "bold with nested italic" case fails, check whether `childMarks` is counting the nested node's markers as the outer node's — it walks only the `firstChild`/`nextSibling` level and does not recurse, which is deliberate.

- [ ] **Step 6: Wire it into the editor and verify by hand**

In `createExtensions` in `src/web/editor/setup.ts`, after `markdown()`, add:

```ts
import { inlineDecorations } from './live/inline.js'
import './live/inline.css'
// ...
    markdown(),
    inlineDecorations(),
```

Run: `pnpm dev:server` and `pnpm dev:web`, type a line like `this is **bold** and *italic* and \`code\`` in the browser, and confirm the markers disappear when the cursor moves away and reappear when it moves back.

- [ ] **Step 7: Commit**

```bash
git add src/web/editor/live/inline.ts src/web/editor/live/inline.css src/web/editor/setup.ts tests/web/editor/inline.test.ts
git commit -m "feat(editor): add inline live preview for emphasis, code, and strikethrough"
```

---

### Task 3: The inline layer — links and heading markers

**Files:**
- Create: `src/web/editor/live/links.ts`
- Create: `src/web/editor/live/headings.ts`
- Create: `src/web/editor/live/headings.css`, `src/web/editor/live/links.css`
- Test: `tests/web/editor/links.test.ts`, `tests/web/editor/headings.test.ts`

**Interfaces:**
- Consumes: everything exported by Task 1
- Produces: `export function linkDecorations(): Extension`、`export function headingDecorations(): Extension`

Link handling: in `[text](url)`, hide `[`, `](url)`, and `)`, leaving only "text" with an `ink-link` class. A bare URL (the `URL` node) only gets the class and is not hidden.

Heading handling: the `## ` prefix is hidden and the whole line gets an `ink-h1`…`ink-h6` **line decoration** (`Decoration.line`), with font size and underline left to CSS.

- [ ] **Step 1: Write the failing link tests**

`tests/web/editor/links.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { linkDecorations } from '../../../src/web/editor/live/links.js'
import { readDecorations, stateWithCursor, withView } from '../../../src/web/editor/live/testing.js'

const EXT = [markdown(), linkDecorations()]

function decosFor(doc: string) {
  return withView(stateWithCursor(doc, EXT), (view) => readDecorations(view))
}

describe('inline links', () => {
  it('hides the brackets and URL, keeping the text', () => {
    // '[text](http://x)' → [ spans [0,1), text spans [1,5), ](http://x) spans [5,16)
    const decos = decosFor('|[text](http://x)')
    expect(decos).toContainEqual({ from: 0, to: 1, kind: 'replace' })
    expect(decos).toContainEqual({ from: 1, to: 5, kind: 'mark', class: 'ink-link' })
    expect(decos).toContainEqual({ from: 5, to: 16, kind: 'replace' })
  })

  it('reveals everything when the cursor enters', () => {
    const decos = decosFor('[te|xt](http://x)')
    expect(decos.some((d) => d.kind === 'replace')).toBe(false)
  })

  it('the cursor in the URL part also counts as entering', () => {
    const decos = decosFor('[text](http://|x)')
    expect(decos.some((d) => d.kind === 'replace')).toBe(false)
  })

  it('the text part still keeps the ink-link class', () => {
    const decos = decosFor('[te|xt](http://x)')
    expect(decos).toContainEqual({ from: 1, to: 5, kind: 'mark', class: 'ink-link' })
  })
})

describe('image syntax is not handled by the link extension', () => {
  it('![alt](src) is left to the image extension, and the link extension produces no decorations', () => {
    expect(decosFor('|![alt](img.png)')).toEqual([])
  })
})

describe('bare URLs', () => {
  it('only adds the class and hides no characters', () => {
    const decos = decosFor('|see <http://x> here')
    expect(decos.some((d) => d.kind === 'replace')).toBe(false)
    expect(decos.some((d) => d.class === 'ink-link')).toBe(true)
  })
})
```

- [ ] **Step 2: Write the failing heading tests**

`tests/web/editor/headings.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { headingDecorations } from '../../../src/web/editor/live/headings.js'
import { readDecorations, stateWithCursor, withView } from '../../../src/web/editor/live/testing.js'

const EXT = [markdown(), headingDecorations()]

function decosFor(doc: string) {
  return withView(stateWithCursor(doc, EXT), (view) => readDecorations(view))
}

describe('ATX headings', () => {
  it('hides the # and the space after it when the cursor is elsewhere', () => {
    // '## Title' → HeaderMark spans [0,2), the space is at 2
    const decos = decosFor('## Title\n\n|body')
    expect(decos).toContainEqual({ from: 0, to: 3, kind: 'replace' })
  })

  it('the whole line carries the level class', () => {
    const decos = decosFor('## Title\n\n|body')
    expect(decos).toContainEqual({ from: 0, to: 0, kind: 'line', class: 'ink-h2' })
  })

  it('reveals the # when the cursor is on the heading line', () => {
    const decos = decosFor('## Ti|tle')
    expect(decos.some((d) => d.kind === 'replace')).toBe(false)
  })

  it('keeps the line class even when the cursor is on the heading line', () => {
    const decos = decosFor('## Ti|tle')
    expect(decos).toContainEqual({ from: 0, to: 0, kind: 'line', class: 'ink-h2' })
  })

  it('a distinct class for each of the six levels', () => {
    for (let level = 1; level <= 6; level += 1) {
      const decos = decosFor(`${'#'.repeat(level)} T\n\n|body`)
      expect(decos).toContainEqual({ from: 0, to: 0, kind: 'line', class: `ink-h${level}` })
    }
  })
})

describe('no false positives', () => {
  it('a # in body text is not handled', () => {
    expect(decosFor('|a # b')).toEqual([])
  })

  it('a # inside a code block is not handled', () => {
    expect(decosFor('|```\n# not a heading\n```')).toEqual([])
  })
})
```

- [ ] **Step 3: Run both tests and confirm they fail**

Run: `pnpm vitest run tests/web/editor/links.test.ts tests/web/editor/headings.test.ts`
Expected: FAIL, neither module exists

- [ ] **Step 4: Implement links.ts**

```ts
import type { Extension, Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { buildSet, hideMark, iterateTree, selectionTouches } from './shared.js'

const linkMark = Decoration.mark({ class: 'ink-link' })

function collect(view: EditorView): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  const state = view.state

  for (const { from, to } of view.visibleRanges) {
    iterateTree(state, from, to, (node) => {
      if (node.name === 'URL' || node.name === 'Autolink') {
        ranges.push(linkMark.range(node.from, node.to))
        return
      }
      if (node.name !== 'Link') return

      // an Image's syntax tree also contains a Link structure; leave it to the image extension
      if (node.node.parent?.name === 'Image') return

      const marks = node.node.getChildren('LinkMark')
      if (marks.length < 2) return

      const textFrom = marks[0]!.to
      const textTo = marks[1]!.from
      if (textTo > textFrom) ranges.push(linkMark.range(textFrom, textTo))

      if (selectionTouches(state, node.from, node.to)) return

      // hide the opening [ and everything from ] to the end of the node (](url) or ](url "title"))
      ranges.push(hideMark.range(marks[0]!.from, marks[0]!.to))
      ranges.push(hideMark.range(marks[1]!.from, node.to))
    })
  }

  return buildSet(ranges)
}

const linkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = collect(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = collect(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

const linkAtomic = EditorView.atomicRanges.of((view) => {
  const plugin = view.plugin(linkPlugin)
  if (!plugin) return Decoration.none
  const hidden: Array<Range<Decoration>> = []
  const iter = plugin.decorations.iter()
  while (iter.value) {
    if ((iter.value.spec as { class?: string }).class === undefined) {
      hidden.push(hideMark.range(iter.from, iter.to))
    }
    iter.next()
  }
  return buildSet(hidden)
})

export function linkDecorations(): Extension {
  return [linkPlugin, linkAtomic]
}
```

- [ ] **Step 5: Implement headings.ts**

Headings need a **line decoration**, and `Decoration.line` must come from a `StateField` — a `ViewPlugin` cannot provide line decorations.

```ts
import { syntaxTree } from '@codemirror/language'
import { StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { buildSet, hideMark, selectionTouches } from './shared.js'

const HEADING_LEVELS: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
}

const lineDecorations = new Map(
  Object.values(HEADING_LEVELS).map((level) => [
    level,
    Decoration.line({ class: `ink-h${level}` }),
  ]),
)

function compute(state: Parameters<typeof syntaxTree>[0]): DecorationSet {
  const ranges: Array<Range<Decoration>> = []

  syntaxTree(state).iterate({
    enter: (node) => {
      const level = HEADING_LEVELS[node.name]
      if (level === undefined) return

      const line = state.doc.lineAt(node.from)
      ranges.push(lineDecorations.get(level)!.range(line.from))

      if (selectionTouches(state, node.from, node.to)) return

      const mark = node.node.firstChild
      if (!mark || mark.name !== 'HeaderMark') return

      // hide the space after the # along with it, or the heading text gains a leading space
      const text = state.doc.sliceString(mark.to, mark.to + 1)
      const end = text === ' ' ? mark.to + 1 : mark.to
      ranges.push(hideMark.range(mark.from, end))
    },
  })

  return buildSet(ranges)
}

const headingField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (value, tr) => {
    if (!tr.docChanged && !tr.selection) return value
    return compute(tr.state)
  },
  provide: (field) => EditorView.decorations.from(field),
})

const headingAtomic = EditorView.atomicRanges.of((view) => {
  const set = view.state.field(headingField, false)
  if (!set) return Decoration.none
  const hidden: Array<Range<Decoration>> = []
  const iter = set.iter()
  while (iter.value) {
    if (iter.to > iter.from) hidden.push(hideMark.range(iter.from, iter.to))
    iter.next()
  }
  return buildSet(hidden)
})

export function headingDecorations(): Extension {
  return [headingField, headingAtomic]
}
```

`headingAtomic` filters with `iter.to > iter.from`: a line decoration has the same from and to (zero width) and should not go into atomicRanges.

- [ ] **Step 6: Write the CSS**

`src/web/editor/live/headings.css` — aligned with Typora's default theme: h1/h2 carry an underline, and heading top margins are noticeably larger than bottom margins.

```css
.ink-h1,
.ink-h2,
.ink-h3,
.ink-h4,
.ink-h5,
.ink-h6 {
  font-weight: 600;
  line-height: 1.3;
  margin-top: 1.6em;
  margin-bottom: 0.5em;
}

.ink-h1 {
  font-size: 2em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--ink-rule);
}

.ink-h2 {
  font-size: 1.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--ink-rule);
}

.ink-h3 { font-size: 1.25em; }
.ink-h4 { font-size: 1em; }
.ink-h5 { font-size: 0.9em; }
.ink-h6 { font-size: 0.9em; color: var(--ink-fg-muted); }
```

`src/web/editor/live/links.css`：

```css
.ink-link {
  color: var(--ink-link);
  cursor: pointer;
}
```

- [ ] **Step 7: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/editor/`
Expected: PASS, the 6 links and 7 headings cases plus the previous two tasks' cases all green

- [ ] **Step 8: Wire it up and commit**

Add `headingDecorations()` and `linkDecorations()` to `setup.ts`'s extension array, and import both CSS files.

```bash
git add src/web/editor/live src/web/editor/setup.ts tests/web/editor
git commit -m "feat(editor): add live preview for links and ATX headings"
```

---

### Task 4: Block-layer groundwork and the cached widget base class

The next four tasks (code blocks, math, Mermaid, images) all insert widgets with height into the document. They share one mechanism for "cache by source string, and hold the height across an async render", so build it first.

**Files:**
- Create: `src/web/editor/live/block.ts`
- Create: `src/web/editor/live/CachedWidget.ts`
- Test: `tests/web/editor/block.test.ts`

**Interfaces:**
- Consumes: everything exported by Task 1
- Produces:

```ts
// src/web/editor/live/CachedWidget.ts
export abstract class CachedWidget extends WidgetType {
  constructor(readonly source: string)
  /** Same source means the same widget, so CM6 reuses the existing DOM and skips the re-render entirely. */
  eq(other: CachedWidget): boolean
  /** Subclasses implement the synchronous render; subclasses that render asynchronously override renderAsync. */
  protected abstract render(container: HTMLElement): void
  toDOM(): HTMLElement
}

export abstract class AsyncCachedWidget extends CachedWidget {
  /** While rendering, keep the previous height as a placeholder so the page does not jump on completion. */
  protected abstract renderAsync(container: HTMLElement): Promise<void>
  protected static heightCache: Map<string, number>
}

// src/web/editor/live/block.ts
export interface BlockRule {
  /** The Lezer node name this rule handles */
  nodes: readonly string[]
  /** Returning null means this node is not replaced this time */
  build(node: SyntaxNodeRef, state: EditorState): WidgetType | null
}
/** Assembles a set of BlockRules into one StateField-driven extension. */
export function blockDecorations(rules: readonly BlockRule[]): Extension
```

`blockDecorations` is uniformly responsible for walking the whole tree, calling `selectionTouchesBlock` on each matching node to decide whether to skip it, wrapping the widget in `Decoration.replace({ widget, block: true })`, and registering `atomicRanges`. Each extension only has to supply a `BlockRule` and never rewrites this skeleton.

- [ ] **Step 1: Write the failing block tests**

`tests/web/editor/block.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { WidgetType } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { blockDecorations, type BlockRule } from '../../../src/web/editor/live/block.js'
import { CachedWidget } from '../../../src/web/editor/live/CachedWidget.js'
import { readDecorations, stateWithCursor, withView } from '../../../src/web/editor/live/testing.js'

class ProbeWidget extends CachedWidget {
  protected render(container: HTMLElement): void {
    container.textContent = `rendered:${this.source}`
  }
}

const probeRule: BlockRule = {
  nodes: ['FencedCode'],
  build: (node, state) => new ProbeWidget(state.doc.sliceString(node.from, node.to)),
}

const EXT = [markdown(), blockDecorations([probeRule])]

function decosFor(doc: string) {
  return withView(stateWithCursor(doc, EXT), (view) => readDecorations(view))
}

describe('blockDecorations', () => {
  it('replaces the whole block with a widget when the cursor is outside it', () => {
    const decos = decosFor('para\n\n```\ncode\n```\n\n|end')
    const replaced = decos.find((d) => d.widget === 'ProbeWidget')
    expect(replaced).toBeDefined()
    expect(replaced!.from).toBe(6)
  })

  it('does not replace when the cursor is inside the block', () => {
    const decos = decosFor('para\n\n```\nco|de\n```\n\nend')
    expect(decos.some((d) => d.widget === 'ProbeWidget')).toBe(false)
  })

  it('the cursor on the block\'s fence line also counts as inside', () => {
    const decos = decosFor('para\n\n``|`\ncode\n```\n\nend')
    expect(decos.some((d) => d.widget === 'ProbeWidget')).toBe(false)
  })

  it('two blocks do not affect each other', () => {
    const doc = '```\na\n```\n\n```\nb|\n```'
    const decos = withView(stateWithCursor(doc, EXT), (view) => readDecorations(view))
    expect(decos.filter((d) => d.widget === 'ProbeWidget')).toHaveLength(1)
  })

  it('does not replace when build returns null', () => {
    const nullRule: BlockRule = { nodes: ['FencedCode'], build: () => null }
    const decos = withView(
      stateWithCursor('|para\n\n```\ncode\n```', [markdown(), blockDecorations([nullRule])]),
      (view) => readDecorations(view),
    )
    expect(decos).toEqual([])
  })

  it('a non-matching node produces no decorations', () => {
    expect(decosFor('|just a paragraph')).toEqual([])
  })
})

describe('CachedWidget.eq', () => {
  it('equal for the same source', () => {
    expect(new ProbeWidget('x').eq(new ProbeWidget('x'))).toBe(true)
  })

  it('not equal for different source', () => {
    expect(new ProbeWidget('x').eq(new ProbeWidget('y'))).toBe(false)
  })

  it('not equal for different types', () => {
    class OtherWidget extends CachedWidget {
      protected render(): void {}
    }
    expect(new ProbeWidget('x').eq(new OtherWidget('x') as unknown as ProbeWidget)).toBe(false)
  })
})

describe('CachedWidget.toDOM', () => {
  it('calls render to populate the container', () => {
    const dom = new ProbeWidget('abc').toDOM()
    expect(dom.textContent).toBe('rendered:abc')
  })

  it('the container carries the ink-block class', () => {
    expect(new ProbeWidget('abc').toDOM().className).toContain('ink-block')
  })

  it('degrades to the source text rather than crashing when the render throws', () => {
    class BrokenWidget extends CachedWidget {
      protected render(): void {
        throw new Error('boom')
      }
    }
    const dom = new BrokenWidget('raw source').toDOM()
    expect(dom.textContent).toContain('raw source')
    expect(dom.className).toContain('ink-block-error')
  })
})
```

The last case is a hard requirement: one Mermaid diagram failing to render must not take the whole editor down with it.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/editor/block.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement CachedWidget.ts**

```ts
import { WidgetType } from '@codemirror/view'

/**
 * A widget base class whose identity is its source string.
 * CM6 uses eq() to decide whether the existing DOM can be reused — the same source skips the re-render entirely,
 * which is what keeps an expensive render like Mermaid from locking up on every keystroke.
 */
export abstract class CachedWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }

  override eq(other: WidgetType): boolean {
    return other.constructor === this.constructor && (other as CachedWidget).source === this.source
  }

  protected abstract render(container: HTMLElement): void

  override toDOM(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'ink-block'
    try {
      this.render(container)
    } catch (err) {
      container.className = 'ink-block ink-block-error'
      const pre = document.createElement('pre')
      pre.textContent = this.source
      const msg = document.createElement('div')
      msg.className = 'ink-block-error-msg'
      msg.textContent = err instanceof Error ? err.message : String(err)
      container.append(msg, pre)
    }
    return container
  }

  /** Block widgets take part in height calculation, so CM6 must be told they are not inline. */
  override get estimatedHeight(): number {
    return -1
  }
}

/**
 * A widget that renders asynchronously. Until the render completes it holds the last recorded height as a placeholder,
 * so the page does not jump down and scramble the scroll position when the diagram finishes.
 */
export abstract class AsyncCachedWidget extends CachedWidget {
  protected static readonly heightCache = new Map<string, number>()

  protected abstract renderAsync(container: HTMLElement): Promise<void>

  protected override render(container: HTMLElement): void {
    const cached = AsyncCachedWidget.heightCache.get(this.source)
    if (cached !== undefined) {
      container.style.minHeight = `${cached}px`
    }
    container.classList.add('ink-block-pending')

    void this.renderAsync(container)
      .then(() => {
        container.classList.remove('ink-block-pending')
        container.style.minHeight = ''
        AsyncCachedWidget.heightCache.set(this.source, container.offsetHeight)
      })
      .catch((err: unknown) => {
        container.classList.remove('ink-block-pending')
        container.classList.add('ink-block-error')
        container.style.minHeight = ''
        const msg = document.createElement('div')
        msg.className = 'ink-block-error-msg'
        msg.textContent = err instanceof Error ? err.message : String(err)
        const pre = document.createElement('pre')
        pre.textContent = this.source
        container.replaceChildren(msg, pre)
      })
  }
}
```

- [ ] **Step 4: Implement block.ts**

```ts
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import { buildSet, selectionTouchesBlock } from './shared.js'

export interface BlockRule {
  nodes: readonly string[]
  build(node: SyntaxNodeRef, state: EditorState): WidgetType | null
}

function compute(state: EditorState, rules: readonly BlockRule[]): DecorationSet {
  const byNode = new Map<string, BlockRule>()
  for (const rule of rules) {
    for (const name of rule.nodes) byNode.set(name, rule)
  }

  const ranges: Array<Range<Decoration>> = []

  syntaxTree(state).iterate({
    enter: (node) => {
      const rule = byNode.get(node.name)
      if (!rule) return
      if (selectionTouchesBlock(state, node)) return

      const widget = rule.build(node, state)
      if (!widget) return

      ranges.push(
        Decoration.replace({ widget, block: true }).range(node.from, node.to),
      )
      // the whole block is already replaced, so there is no need to walk into it
      return false
    },
  })

  return buildSet(ranges)
}

export function blockDecorations(rules: readonly BlockRule[]): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => compute(state, rules),
    update: (value, tr) => {
      if (!tr.docChanged && !tr.selection) return value
      return compute(tr.state, rules)
    },
    provide: (f) => EditorView.decorations.from(f),
  })

  const atomic = EditorView.atomicRanges.of((view) => view.state.field(field, false) ?? Decoration.none)

  return [field, atomic]
}
```

- [ ] **Step 5: Write the block CSS**

`src/web/editor/live/block.css`：

```css
.ink-block {
  margin: 1em 0;
}

.ink-block-pending {
  opacity: 0.5;
}

.ink-block-error {
  background: var(--ink-code-bg);
  padding: 8px 12px;
}

.ink-block-error-msg {
  color: var(--ink-danger);
  font-size: 12px;
  margin-bottom: 6px;
}

.ink-block-error pre {
  margin: 0;
  font-family: var(--ink-font-mono);
  font-size: 0.9em;
  white-space: pre-wrap;
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/editor/block.test.ts`
Expected: PASS, all 12 cases green

If "the cursor on the fence line also counts as inside" fails, check whether `BLOCK_NODES` in `selectionTouchesBlock` includes `FencedCode` — Task 1 added it, but node names can change with the `@lezer/markdown` version, so print the actual names with `syntaxTree(state).toString()` and cross-check.

- [ ] **Step 7: Commit**

```bash
git add src/web/editor/live/block.ts src/web/editor/live/CachedWidget.ts src/web/editor/live/block.css tests/web/editor/block.test.ts
git commit -m "feat(editor): add block decoration framework with cached async widgets"
```

---

### Task 5: Code block highlighting

Code blocks are **not replaced with a widget** — users frequently want to edit the code directly, and swapping in a read-only render just gets in the way. Instead, the fence lines get line decorations and the code body gets syntax highlighting, staying editable whether the cursor is there or not. This is the one construct in this phase where WYSIWYG does not mean replacement.

**Files:**
- Create: `src/web/editor/live/code.ts`, `src/web/editor/live/code.css`
- Test: `tests/web/editor/code.test.ts`

**Interfaces:**
- Consumes: Task 1's exports, `@codemirror/language-data`
- Produces: `export function codeDecorations(): Extension`

- [ ] **Step 1: Write the failing code block tests**

`tests/web/editor/code.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { describe, expect, it } from 'vitest'
import { codeDecorations } from '../../../src/web/editor/live/code.js'
import { readDecorations, stateWithCursor, withView } from '../../../src/web/editor/live/testing.js'

const EXT = [markdown({ codeLanguages: languages }), codeDecorations()]

function decosFor(doc: string) {
  return withView(stateWithCursor(doc, EXT), (view) => readDecorations(view))
}

describe('fenced code blocks', () => {
  it('every line of the code block carries the ink-code-line class', () => {
    const decos = decosFor('|```js\nconst a = 1\n```')
    const lines = decos.filter((d) => d.kind === 'line' && d.class === 'ink-code-line')
    expect(lines).toHaveLength(3)
  })

  it('the first line additionally carries ink-code-first', () => {
    const decos = decosFor('|```js\nconst a = 1\n```')
    expect(decos.some((d) => d.class === 'ink-code-first')).toBe(true)
  })

  it('the last line additionally carries ink-code-last', () => {
    const decos = decosFor('|```js\nconst a = 1\n```')
    expect(decos.some((d) => d.class === 'ink-code-last')).toBe(true)
  })

  it('the decorations remain when the cursor is inside the block (code blocks are always editable)', () => {
    const decos = decosFor('```js\nconst a| = 1\n```')
    expect(decos.filter((d) => d.class === 'ink-code-line')).toHaveLength(3)
  })

  it('the language tag is hidden', () => {
    // in '```js', CodeInfo 'js' spans [3,5)
    const decos = decosFor('|```js\ncode\n```')
    expect(decos).toContainEqual({ from: 3, to: 5, kind: 'replace' })
  })

  it('reveals the language tag when the cursor is on the fence line', () => {
    const decos = decosFor('```j|s\ncode\n```')
    expect(decos.some((d) => d.kind === 'replace')).toBe(false)
  })

  it('a code block with no language tag works too', () => {
    const decos = decosFor('|```\ncode\n```')
    expect(decos.filter((d) => d.class === 'ink-code-line')).toHaveLength(3)
  })
})

describe('indented code blocks', () => {
  it('also carry ink-code-line', () => {
    const decos = decosFor('para\n\n    indented code\n\n|end')
    expect(decos.some((d) => d.class === 'ink-code-line')).toBe(true)
  })
})

describe('no false positives', () => {
  it('inline code does not carry the block classes', () => {
    const decos = decosFor('|a `code` b')
    expect(decos.some((d) => d.class === 'ink-code-line')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/editor/code.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement code.ts**

```ts
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { buildSet, hideMark, selectionTouches } from './shared.js'

const codeLine = Decoration.line({ class: 'ink-code-line' })
const codeFirst = Decoration.line({ class: 'ink-code-first' })
const codeLast = Decoration.line({ class: 'ink-code-last' })

function compute(state: EditorState): DecorationSet {
  const ranges: Array<Range<Decoration>> = []

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') return

      const firstLine = state.doc.lineAt(node.from).number
      const lastLine = state.doc.lineAt(node.to).number

      for (let n = firstLine; n <= lastLine; n += 1) {
        const line = state.doc.line(n)
        ranges.push(codeLine.range(line.from))
        if (n === firstLine) ranges.push(codeFirst.range(line.from))
        if (n === lastLine) ranges.push(codeLast.range(line.from))
      }

      if (node.name !== 'FencedCode') return
      if (selectionTouches(state, node.from, node.to)) return

      // hide the language tag after the ```, keeping the fence itself — it is the visual cue for the block boundary
      const info = node.node.getChild('CodeInfo')
      if (info) ranges.push(hideMark.range(info.from, info.to))
    },
  })

  return buildSet(ranges)
}

const codeField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (value, tr) => {
    if (!tr.docChanged && !tr.selection) return value
    return compute(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

export function codeDecorations(): Extension {
  return [codeField]
}
```

Code blocks register no `atomicRanges`: the whole block must stay editable, and arrow keys have to be able to walk into it character by character.

- [ ] **Step 4: Write code.css**

```css
.ink-code-line {
  background: var(--ink-code-bg);
  font-family: var(--ink-font-mono);
  font-size: 0.92em;
  padding-left: 12px;
  padding-right: 12px;
}

.ink-code-first {
  padding-top: 8px;
  border-radius: 3px 3px 0 0;
}

.ink-code-last {
  padding-bottom: 8px;
  border-radius: 0 0 3px 3px;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/editor/code.test.ts`
Expected: PASS, all 9 cases green

- [ ] **Step 6: Turn on syntax highlighting**

In `setup.ts`, swap `markdown()` for the version with language support and add the syntax highlighting theme:

```ts
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
// ...
    markdown({ codeLanguages: languages }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    codeDecorations(),
```

`codeLanguages: languages` lets Lezer dynamically load the matching parser from the `CodeInfo` language tag, so the inside of a code block has a real syntax tree to highlight.

- [ ] **Step 7: Commit**

```bash
git add src/web/editor/live/code.ts src/web/editor/live/code.css src/web/editor/setup.ts tests/web/editor/code.test.ts
git commit -m "feat(editor): style fenced code blocks and enable embedded language highlighting"
```

---

### Task 6: Math formulas (KaTeX)

**Files:**
- Create: `src/web/editor/live/math.ts`, `src/web/editor/live/math.css`
- Test: `tests/web/editor/math.test.ts`

**Interfaces:**
- Consumes: `CachedWidget`、`BlockRule`、`blockDecorations`（Task 4）
- Produces: `export function mathDecorations(): Extension`、`export class MathBlockWidget extends CachedWidget`

`@lezer/markdown` does not parse `$...$` by default. This needs two custom inline/block parse rules via its `MarkdownExtension` mechanism, or extending the part `@codemirror/lang-markdown` cannot cover ourselves. Here we go the custom-delimiter route.

- [ ] **Step 1: Install KaTeX**

```bash
pnpm add katex
pnpm add -D @types/katex
```

- [ ] **Step 2: Write the failing math tests**

`tests/web/editor/math.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { mathDecorations, mathMarkdownExtension } from '../../../src/web/editor/live/math.js'
import { readDecorations, stateWithCursor, withView } from '../../../src/web/editor/live/testing.js'

const EXT = [markdown({ extensions: [mathMarkdownExtension] }), mathDecorations()]

function decosFor(doc: string) {
  return withView(stateWithCursor(doc, EXT), (view) => readDecorations(view))
}

describe('inline math', () => {
  it('replaces the whole $...$ with a widget when the cursor is elsewhere', () => {
    const decos = decosFor('|text $x^2$ more')
    const widget = decos.find((d) => d.widget === 'MathInlineWidget')
    expect(widget).toBeDefined()
    expect(widget!.from).toBe(5)
    expect(widget!.to).toBe(10)
  })

  it('reveals the source when the cursor enters', () => {
    const decos = decosFor('text $x^|2$ more')
    expect(decos.some((d) => d.widget === 'MathInlineWidget')).toBe(false)
  })

  it('a single $ does not trigger it', () => {
    expect(decosFor('|price is $5 today')).toEqual([])
  })

  it('nothing between the $ does not trigger it', () => {
    expect(decosFor('|a $$ b')).toEqual([])
  })
})

describe('block math', () => {
  it('a $$ block is replaced by MathBlockWidget', () => {
    const decos = decosFor('para\n\n$$\nx = 1\n$$\n\n|end')
    expect(decos.some((d) => d.widget === 'MathBlockWidget')).toBe(true)
  })

  it('the cursor anywhere in the block reveals the whole block', () => {
    const decos = decosFor('para\n\n$$\nx =| 1\n$$\n\nend')
    expect(decos.some((d) => d.widget === 'MathBlockWidget')).toBe(false)
  })

  it('the cursor on the opening $$ line also reveals the whole block', () => {
    const decos = decosFor('para\n\n$|$\nx = 1\n$$\n\nend')
    expect(decos.some((d) => d.widget === 'MathBlockWidget')).toBe(false)
  })
})

describe('KaTeX rendering', () => {
  it('renders katex DOM', async () => {
    const { MathInlineWidget } = await import('../../../src/web/editor/live/math.js')
    const dom = new MathInlineWidget('$x^2$').toDOM()
    expect(dom.querySelector('.katex')).not.toBeNull()
  })

  it('an invalid formula degrades to an error block rather than throwing', async () => {
    const { MathInlineWidget } = await import('../../../src/web/editor/live/math.js')
    const dom = new MathInlineWidget('$\\frac{1}$').toDOM()
    expect(dom.className).toContain('ink-block-error')
    expect(dom.textContent).toContain('\\frac{1}')
  })

  it('widgets with the same source are equal (triggering DOM reuse)', async () => {
    const { MathBlockWidget } = await import('../../../src/web/editor/live/math.js')
    expect(new MathBlockWidget('$$x$$').eq(new MathBlockWidget('$$x$$'))).toBe(true)
    expect(new MathBlockWidget('$$x$$').eq(new MathBlockWidget('$$y$$'))).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/editor/math.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 4: Implement math.ts**

```ts
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { MarkdownConfig } from '@lezer/markdown'
import { tags, Tag } from '@lezer/highlight'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { blockDecorations, type BlockRule } from './block.js'
import { CachedWidget } from './CachedWidget.js'
import { buildSet, selectionTouches } from './shared.js'

const mathTag = Tag.define(tags.special(tags.content))

/**
 * Adds the two constructs $...$ and $$...$$ to @lezer/markdown.
 * InlineMath uses the delimiter mechanism; BlockMath uses a block parser matching a $$ on a line of its own.
 */
export const mathMarkdownExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: mathTag },
    { name: 'BlockMath', block: true, style: mathTag },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== 36 /* $ */) return -1
        // do not match $$ (that is the block form), and do not match a $ followed by whitespace (most likely a currency symbol)
        if (cx.char(pos + 1) === 36) return -1
        const line = cx.text
        const offset = pos - cx.offset
        const close = line.indexOf('$', offset + 1)
        if (close < 0) return -1
        if (close === offset + 1) return -1 // empty content
        const end = cx.offset + close + 1
        return cx.addElement(cx.elt('InlineMath', pos, end))
      },
      after: 'Emphasis',
    },
  ],
  parseBlock: [
    {
      name: 'BlockMath',
      parse(cx, line) {
        if (!/^\$\$\s*$/.test(line.text.slice(line.pos))) return false
        const start = cx.lineStart
        while (cx.nextLine()) {
          if (/^\$\$\s*$/.test(line.text)) {
            const end = cx.lineStart + line.text.length
            cx.addElement(cx.elt('BlockMath', start, end))
            cx.nextLine()
            return true
          }
        }
        return false
      },
      before: 'Blockquote',
    },
  ],
}

function stripDelimiters(source: string): { tex: string; display: boolean } {
  const trimmed = source.trim()
  if (trimmed.startsWith('$$')) {
    return { tex: trimmed.slice(2, -2).trim(), display: true }
  }
  return { tex: trimmed.slice(1, -1), display: false }
}

export class MathInlineWidget extends CachedWidget {
  protected render(container: HTMLElement): void {
    const { tex } = stripDelimiters(this.source)
    container.className = 'ink-math-inline'
    katex.render(tex, container, { displayMode: false, throwOnError: true })
  }

  override get estimatedHeight(): number {
    return -1
  }
}

export class MathBlockWidget extends CachedWidget {
  protected render(container: HTMLElement): void {
    const { tex } = stripDelimiters(this.source)
    container.classList.add('ink-math-block')
    katex.render(tex, container, { displayMode: true, throwOnError: true })
  }
}

const blockRule: BlockRule = {
  nodes: ['BlockMath'],
  build: (node, state) => new MathBlockWidget(state.doc.sliceString(node.from, node.to)),
}

/** Inline math replaces the whole node, so it cannot reuse blockDecorations (which only handles block level). */
function computeInline(state: EditorState): DecorationSet {
  const ranges: Array<Range<Decoration>> = []

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'InlineMath') return
      if (selectionTouches(state, node.from, node.to)) return
      const source = state.doc.sliceString(node.from, node.to)
      ranges.push(
        Decoration.replace({ widget: new MathInlineWidget(source) }).range(node.from, node.to),
      )
    },
  })

  return buildSet(ranges)
}

const inlineMathField = StateField.define<DecorationSet>({
  create: (state) => computeInline(state),
  update: (value, tr) => {
    if (!tr.docChanged && !tr.selection) return value
    return computeInline(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

const inlineMathAtomic = EditorView.atomicRanges.of(
  (view) => view.state.field(inlineMathField, false) ?? Decoration.none,
)

export function mathDecorations(): Extension {
  return [blockDecorations([blockRule]), inlineMathField, inlineMathAtomic]
}
```

`throwOnError: true` in `MathInlineWidget`'s `render` is deliberate — the exception is caught by `CachedWidget.toDOM`'s try/catch and degrades to an error block, which fits our unified error styling better than KaTeX's own red placeholder.

- [ ] **Step 5: Write math.css**

```css
.ink-math-inline {
  display: inline-block;
}

.ink-math-block {
  text-align: center;
  padding: 0.5em 0;
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/editor/math.test.ts`
Expected: PASS, all 10 cases green

If the inline math parseInline case fails, first print the actual syntax tree with `syntaxTree(state).toString()` to check whether the node is really being parsed — `@lezer/markdown`'s `parseInline` interface has changed signature between minor versions, so adjust the use of `cx.char`/`cx.offset` to whatever version is actually installed locally.

- [ ] **Step 7: Wire it up and commit**

In `setup.ts`, change `markdown({ codeLanguages: languages })` to `markdown({ codeLanguages: languages, extensions: [mathMarkdownExtension] })` and add `mathDecorations()`.

```bash
git add package.json src/web/editor/live/math.ts src/web/editor/live/math.css src/web/editor/setup.ts tests/web/editor/math.test.ts
git commit -m "feat(editor): render inline and block math with katex"
```

---

### Task 7: Mermaid diagrams

All of this task's difficulty is in not locking up. One Mermaid render takes tens to hundreds of milliseconds, and re-rendering on every keystroke makes the editor unusable outright.

**Files:**
- Create: `src/web/editor/live/mermaid.ts`, `src/web/editor/live/mermaid.css`
- Test: `tests/web/editor/mermaid.test.ts`

**Interfaces:**
- Consumes: `AsyncCachedWidget`、`BlockRule`、`blockDecorations`
- Produces: `export function mermaidDecorations(): Extension`、`export class MermaidWidget extends AsyncCachedWidget`

- [ ] **Step 1: Install mermaid**

```bash
pnpm add mermaid
```

- [ ] **Step 2: Write the failing mermaid tests**

`tests/web/editor/mermaid.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mermaidDecorations, MermaidWidget, setMermaidRenderer } from '../../../src/web/editor/live/mermaid.js'
import { readDecorations, stateWithCursor, withView } from '../../../src/web/editor/live/testing.js'

const EXT = [markdown(), mermaidDecorations()]

function decosFor(doc: string) {
  return withView(stateWithCursor(doc, EXT), (view) => readDecorations(view))
}

const renderSpy = vi.fn()

beforeEach(() => {
  renderSpy.mockReset()
  renderSpy.mockResolvedValue('<svg id="fake"></svg>')
  setMermaidRenderer(renderSpy)
})

afterEach(() => {
  setMermaidRenderer(null)
})

describe('recognizing mermaid code blocks', () => {
  it('```mermaid is replaced by MermaidWidget', () => {
    const decos = decosFor('para\n\n```mermaid\ngraph TD\nA-->B\n```\n\n|end')
    expect(decos.some((d) => d.widget === 'MermaidWidget')).toBe(true)
  })

  it('code blocks in other languages are not replaced', () => {
    const decos = decosFor('para\n\n```js\nconst a = 1\n```\n\n|end')
    expect(decos.some((d) => d.widget === 'MermaidWidget')).toBe(false)
  })

  it('a code block with no language tag is not replaced', () => {
    const decos = decosFor('para\n\n```\ngraph TD\n```\n\n|end')
    expect(decos.some((d) => d.widget === 'MermaidWidget')).toBe(false)
  })

  it('reveals the source when the cursor is inside the block', () => {
    const decos = decosFor('para\n\n```mermaid\ngraph| TD\n```\n\nend')
    expect(decos.some((d) => d.widget === 'MermaidWidget')).toBe(false)
  })
})

describe('rendering and caching', () => {
  it('injects the render result into the container', async () => {
    const dom = new MermaidWidget('```mermaid\ngraph TD\nA-->B\n```').toDOM()
    await vi.waitFor(() => expect(dom.querySelector('svg')).not.toBeNull())
    expect(renderSpy).toHaveBeenCalledTimes(1)
  })

  it('the extracted source does not include the fence lines', async () => {
    new MermaidWidget('```mermaid\ngraph TD\nA-->B\n```').toDOM()
    await vi.waitFor(() => expect(renderSpy).toHaveBeenCalled())
    expect(renderSpy.mock.calls[0][0]).toBe('graph TD\nA-->B')
  })

  it('two widgets with the same source are equal, which is how CM6 skips the re-render', () => {
    const a = new MermaidWidget('```mermaid\ngraph TD\n```')
    const b = new MermaidWidget('```mermaid\ngraph TD\n```')
    expect(a.eq(b)).toBe(true)
  })

  it('different source is not equal', () => {
    const a = new MermaidWidget('```mermaid\ngraph TD\n```')
    const b = new MermaidWidget('```mermaid\ngraph LR\n```')
    expect(a.eq(b)).toBe(false)
  })

  it('carries the pending class while rendering, removed on completion', async () => {
    let resolve!: (svg: string) => void
    renderSpy.mockReturnValue(new Promise<string>((r) => { resolve = r }))
    const dom = new MermaidWidget('```mermaid\ngraph TD\n```').toDOM()
    expect(dom.className).toContain('ink-block-pending')
    resolve('<svg></svg>')
    await vi.waitFor(() => expect(dom.className).not.toContain('ink-block-pending'))
  })

  it('degrades to an error block without throwing when the render fails', async () => {
    renderSpy.mockRejectedValue(new Error('bad syntax'))
    const dom = new MermaidWidget('```mermaid\nnot valid\n```').toDOM()
    await vi.waitFor(() => expect(dom.className).toContain('ink-block-error'))
    expect(dom.textContent).toContain('bad syntax')
    expect(dom.textContent).toContain('not valid')
  })
})
```

`setMermaidRenderer` is an injection point reserved for tests — actually loading mermaid into jsdom is both slow and flaky.

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/editor/mermaid.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 4: Implement mermaid.ts**

```ts
import type { Extension } from '@codemirror/state'
import { blockDecorations, type BlockRule } from './block.js'
import { AsyncCachedWidget } from './CachedWidget.js'

export type MermaidRenderer = (source: string, id: string) => Promise<string>

let renderer: MermaidRenderer | null = null
let idCounter = 0

/** Test injection point. Pass null to restore the real mermaid. */
export function setMermaidRenderer(next: MermaidRenderer | null): void {
  renderer = next
}

/** The real renderer is dynamically imported on demand, to keep mermaid out of the main bundle. */
async function defaultRenderer(source: string, id: string): Promise<string> {
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
  })
  const { svg } = await mermaid.render(id, source)
  return svg
}

/** Extracts the diagram definition itself from ```mermaid ... ```. */
function extractSource(fenced: string): string {
  const lines = fenced.split('\n')
  // drop the opening fence line (including the language tag) and the closing fence line
  const body = lines.slice(1, lines[lines.length - 1]?.trimStart().startsWith('```') ? -1 : undefined)
  return body.join('\n').trim()
}

export class MermaidWidget extends AsyncCachedWidget {
  protected async renderAsync(container: HTMLElement): Promise<void> {
    const render = renderer ?? defaultRenderer
    idCounter += 1
    const svg = await render(extractSource(this.source), `ink-mermaid-${idCounter}`)
    container.classList.add('ink-mermaid')
    container.innerHTML = svg
  }
}

const rule: BlockRule = {
  nodes: ['FencedCode'],
  build: (node, state) => {
    const info = node.node.getChild('CodeInfo')
    if (!info) return null
    if (state.doc.sliceString(info.from, info.to).trim().toLowerCase() !== 'mermaid') return null
    return new MermaidWidget(state.doc.sliceString(node.from, node.to))
  },
}

export function mermaidDecorations(): Extension {
  return blockDecorations([rule])
}
```

`container.innerHTML = svg` is deliberate: mermaid's output is SVG it generated itself, and `securityLevel: 'strict'` has already made it escape the user text in the diagram. The vault's contents are what the user wrote in the first place, and the threat model has no third-party injection.

- [ ] **Step 5: Write mermaid.css**

```css
.ink-mermaid {
  display: flex;
  justify-content: center;
  overflow-x: auto;
}

.ink-mermaid svg {
  max-width: 100%;
  height: auto;
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/editor/mermaid.test.ts`
Expected: PASS, all 10 cases green

- [ ] **Step 7: Verify the ordering against the code block extension**

Task 5's `codeDecorations` adds line decorations to every `FencedCode`, mermaid blocks included. `blockDecorations` then replaces the mermaid block wholesale — line decorations on replaced lines are not displayed, so the two do not conflict. But in ordering, `mermaidDecorations()` must come **after** `codeDecorations()`, so the block replacement takes priority.

Confirm the order in `setup.ts`:

```ts
    codeDecorations(),
    mermaidDecorations(),
```

Manual check: write a ```mermaid block and confirm it renders as a diagram once the cursor moves away, turns back into source when the cursor returns to the fence line, and does not stutter while typing continuously.

- [ ] **Step 8: Commit**

```bash
git add package.json src/web/editor/live/mermaid.ts src/web/editor/live/mermaid.css src/web/editor/setup.ts tests/web/editor/mermaid.test.ts
git commit -m "feat(editor): render mermaid diagrams with source-keyed caching"
```

---

### Task 8: Image rendering and paste upload

**Files:**
- Create: `src/web/editor/live/images.ts`, `src/web/editor/live/images.css`
- Create: `src/web/editor/paste.ts`
- Create: `src/server/routes/assets.ts`
- Modify: `src/server/app.ts`, `src/web/api/client.ts`, `src/web/editor/setup.ts`
- Test: `tests/web/editor/images.test.ts`, `tests/server/routes/assets.test.ts`

**Interfaces:**
- Consumes: `CachedWidget`, `blockDecorations`, `Vault.writeAsset` (Phase 0 Task 3)
- Produces:

```ts
// src/web/editor/live/images.ts
export function imageDecorations(): Extension
export class ImageWidget extends CachedWidget

// src/web/editor/paste.ts
export function pasteImageHandler(upload: (file: File) => Promise<string>): Extension

// added to src/web/api/client.ts
uploadAsset(file: File): Promise<{ path: string }>

// src/server/routes/assets.ts
export function registerAssetRoutes(app: FastifyInstance, deps: AppDeps & { watcher: VaultWatcher }): void
```

Images are presented two ways: an image on a line of its own is replaced by a block widget; an inline image (one in the middle of a run of text) is left as source — Typora does the same, because rendering inline images makes the line height jump.

- [ ] **Step 1: Write the failing asset upload route tests**

`tests/server/routes/assets.test.ts`：

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { login, makeTestApp, type TestApp } from '../helpers/app.js'

let t: TestApp
let cookie: string

beforeEach(async () => {
  t = await makeTestApp()
  cookie = await login(t)
})

afterEach(async () => {
  await t.cleanup()
})

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex')

function multipart(filename: string, contentType: string, bytes: Buffer) {
  const boundary = '----inkstonetest'
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

describe('POST /api/asset', () => {
  it('uploading a PNG returns a relative path under assets/', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/asset',
      ...multipart('shot.png', 'image/png', PNG_BYTES),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().path).toMatch(/^assets\/[a-f0-9]{16}\.png$/)
    const abs = path.join(t.root, res.json().path)
    expect(await fs.readFile(abs)).toEqual(PNG_BYTES)
  })

  it('uploading the same content twice returns the same path', async () => {
    const first = await t.app.inject({ method: 'POST', url: '/api/asset', ...multipart('a.png', 'image/png', PNG_BYTES) })
    const second = await t.app.inject({ method: 'POST', url: '/api/asset', ...multipart('b.png', 'image/png', PNG_BYTES) })
    expect(second.json().path).toBe(first.json().path)
  })

  it('rejects non-image MIME types', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/asset',
      ...multipart('evil.sh', 'application/x-sh', Buffer.from('rm -rf /')),
    })
    expect(res.statusCode).toBe(415)
  })

  it('rejects files over 10MB', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024)
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/asset',
      ...multipart('big.png', 'image/png', big),
    })
    expect(res.statusCode).toBe(413)
  })

  it('returns 401 when not logged in', async () => {
    const parts = multipart('a.png', 'image/png', PNG_BYTES)
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/asset',
      payload: parts.payload,
      headers: { 'content-type': parts.headers['content-type'] },
    })
    expect(res.statusCode).toBe(401)
  })

  it('derives the extension from the MIME type, never trusting the client filename', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/asset',
      ...multipart('../../evil.php', 'image/png', PNG_BYTES),
    })
    expect(res.json().path).toMatch(/\.png$/)
    expect(res.json().path).not.toContain('..')
  })
})

describe('GET /assets/*', () => {
  it('can fetch back an uploaded image', async () => {
    const up = await t.app.inject({ method: 'POST', url: '/api/asset', ...multipart('a.png', 'image/png', PNG_BYTES) })
    const res = await t.app.inject({
      method: 'GET',
      url: `/vault/${up.json().path}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload).toEqual(PNG_BYTES)
  })

  it('fetching an image returns 401 when not logged in', async () => {
    const up = await t.app.inject({ method: 'POST', url: '/api/asset', ...multipart('a.png', 'image/png', PNG_BYTES) })
    const res = await t.app.inject({ method: 'GET', url: `/vault/${up.json().path}` })
    expect(res.statusCode).toBe(401)
  })

  it('a traversal path returns 400', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/vault/../../etc/passwd',
      headers: { cookie },
    })
    expect([400, 404]).toContain(res.statusCode)
  })
})
```

`/vault/*` is the read path for images and also goes through the auth guard — so the rule in `auth.ts` that only intercepts `/api/` has to be extended to `/vault/`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/server/routes/assets.test.ts`
Expected: FAIL, the route does not exist

- [ ] **Step 3: Implement the assets routes**

```bash
pnpm add @fastify/multipart
```

`src/server/routes/assets.ts`：

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../app.js'
import type { VaultWatcher } from '../watcher.js'
import { VaultError } from '../vault/index.js'
import { VaultPathError } from '../vault/paths.js'

const MAX_BYTES = 10 * 1024 * 1024

/** MIME → extension. Never trust the filename supplied by the client. */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
}

export function registerAssetRoutes(
  app: FastifyInstance,
  deps: AppDeps & { watcher: VaultWatcher },
): void {
  app.post('/api/asset', async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_BYTES } })
    if (!file) return reply.code(400).send({ error: 'no file provided' })

    const ext = MIME_EXT[file.mimetype]
    if (!ext) return reply.code(415).send({ error: `unsupported type: ${file.mimetype}` })

    let bytes: Buffer
    try {
      bytes = await file.toBuffer()
    } catch {
      return reply.code(413).send({ error: 'file too large' })
    }
    if (file.file.truncated) return reply.code(413).send({ error: 'file too large' })

    // a fixed seed string: identical content yields the same path, so pasting the same image twice produces no duplicate
    const relPath = await deps.vault.writeAsset(bytes, ext, 'inkstone-asset')
    deps.watcher.markSelfWrite(relPath)
    deps.autoCommit.notifyWrite()
    return reply.code(201).send({ path: relPath })
  })

  app.get<{ Params: { '*': string } }>('/vault/*', async (req, reply) => {
    const relPath = req.params['*']
    try {
      const abs = await deps.vault.resolveForRead(relPath)
      return reply.type(guessMime(relPath)).send(await import('node:fs').then((fs) => fs.createReadStream(abs)))
    } catch (err) {
      if (err instanceof VaultPathError) return reply.code(400).send({ error: 'invalid path' })
      if (err instanceof VaultError) return reply.code(404).send({ error: 'not found' })
      throw err
    }
  })
}

function guessMime(relPath: string): string {
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase()
  const found = Object.entries(MIME_EXT).find(([, e]) => e === ext)
  return found?.[0] ?? 'application/octet-stream'
}
```

`Vault` needs a new `resolveForRead` — the existing `read()` returns a string, and images need a binary stream. Add it to `src/server/vault/index.ts`:

```ts
  /** Validates the path and returns the absolute path, for the caller to read binary content as a stream. */
  async resolveForRead(relPath: string): Promise<string> {
    const abs = await resolveSafe(this.root, relPath)
    const stat = await this.#statOrThrow(abs, relPath)
    if (!stat.isFile()) throw new VaultError(`not a file: ${relPath}`)
    return abs
  }
```

Change the guard in `src/server/auth.ts` to protect `/vault/` as well:

```ts
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/vault/')) return
```

Register multipart and the new routes in `src/server/app.ts`:

```ts
import multipart from '@fastify/multipart'
// ...
  app.register(multipart)
// after registerFileRoutes
    registerAssetRoutes(instance, { ...deps, watcher })
```

- [ ] **Step 4: Run the route tests and confirm they pass**

Run: `pnpm vitest run tests/server/routes/assets.test.ts`
Expected: PASS, all 9 cases green

- [ ] **Step 5: Write the failing image decoration tests**

`tests/web/editor/images.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { imageDecorations, ImageWidget } from '../../../src/web/editor/live/images.js'
import { readDecorations, stateWithCursor, withView } from '../../../src/web/editor/live/testing.js'

const EXT = [markdown(), imageDecorations()]

function decosFor(doc: string) {
  return withView(stateWithCursor(doc, EXT), (view) => readDecorations(view))
}

describe('images on a line of their own', () => {
  it('are replaced by ImageWidget', () => {
    const decos = decosFor('para\n\n![alt](assets/a.png)\n\n|end')
    expect(decos.some((d) => d.widget === 'ImageWidget')).toBe(true)
  })

  it('reveal the source when the cursor is on the image line', () => {
    const decos = decosFor('para\n\n![al|t](assets/a.png)\n\nend')
    expect(decos.some((d) => d.widget === 'ImageWidget')).toBe(false)
  })
})

describe('inline images', () => {
  it('an image in the middle of text is not replaced', () => {
    const decos = decosFor('|text ![alt](a.png) more text')
    expect(decos.some((d) => d.widget === 'ImageWidget')).toBe(false)
  })
})

describe('ImageWidget', () => {
  it('a relative path becomes a src prefixed with /vault/', () => {
    const dom = new ImageWidget('![alt](assets/a.png)').toDOM()
    const img = dom.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/vault/assets/a.png')
  })

  it('an absolute URL is used as-is', () => {
    const dom = new ImageWidget('![alt](https://example.com/a.png)').toDOM()
    expect(dom.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png')
  })

  it('the alt text is written into the alt attribute', () => {
    const dom = new ImageWidget('![my alt](a.png)').toDOM()
    expect(dom.querySelector('img')?.getAttribute('alt')).toBe('my alt')
  })

  it('the src is URL-encoded, so a path with spaces still resolves', () => {
    const dom = new ImageWidget('![a](assets/my file.png)').toDOM()
    expect(dom.querySelector('img')?.getAttribute('src')).toBe('/vault/assets/my%20file.png')
  })

  it('equal for the same source', () => {
    expect(new ImageWidget('![a](x.png)').eq(new ImageWidget('![a](x.png)'))).toBe(true)
  })
})
```

- [ ] **Step 6: Implement images.ts**

```ts
import type { Extension } from '@codemirror/state'
import { blockDecorations, type BlockRule } from './block.js'
import { CachedWidget } from './CachedWidget.js'

const IMAGE_PATTERN = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/

export class ImageWidget extends CachedWidget {
  protected render(container: HTMLElement): void {
    const match = IMAGE_PATTERN.exec(this.source.trim())
    if (!match) throw new Error('unrecognized image syntax')

    const [, alt = '', src = ''] = match
    const img = document.createElement('img')
    img.alt = alt
    img.src = toSrc(src)
    img.loading = 'lazy'
    container.classList.add('ink-image')
    container.append(img)
  }
}

/** A relative path inside the vault is read through /vault/; an absolute URL passes through unchanged. */
function toSrc(raw: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return raw
  return `/vault/${raw.split('/').map(encodeURIComponent).join('/')}`
}

const rule: BlockRule = {
  nodes: ['Image'],
  build: (node, state) => {
    // only handle images on a line of their own: rendering inline images makes the line height jump
    const line = state.doc.lineAt(node.from)
    if (line.from !== node.from || line.to !== node.to) return null
    return new ImageWidget(state.doc.sliceString(node.from, node.to))
  },
}

export function imageDecorations(): Extension {
  return blockDecorations([rule])
}
```

`Image` is not in Task 1's `BLOCK_NODES`, so `selectionTouchesBlock` walks up to its `Paragraph` ancestor — and for an image on a line of its own, the paragraph is that line, so the decision is correct.

- [ ] **Step 7: Write images.css and implement paste handling**

`src/web/editor/live/images.css`：

```css
.ink-image {
  display: flex;
  justify-content: center;
}

.ink-image img {
  max-width: 100%;
  height: auto;
}
```

`src/web/editor/paste.ts`：

```ts
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * A screenshot pasted straight in with Ctrl+V: upload it to assets/ and insert the relative path.
 * Insert a placeholder first, replace it on success, and remove it on failure — never leave the user staring at nothing.
 */
export function pasteImageHandler(upload: (file: File) => Promise<string>): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items
      if (!items) return false

      const imageItem = Array.from(items).find((item) => item.type.startsWith('image/'))
      if (!imageItem) return false

      const file = imageItem.getAsFile()
      if (!file) return false

      event.preventDefault()

      const placeholder = `![uploading…]()`
      const from = view.state.selection.main.from
      view.dispatch({
        changes: { from, to: view.state.selection.main.to, insert: placeholder },
      })

      void upload(file)
        .then((relPath) => {
          replacePlaceholder(view, from, placeholder, `![](${relPath})`)
        })
        .catch(() => {
          replacePlaceholder(view, from, placeholder, '')
        })

      return true
    },
  })
}

/**
 * The user may have typed more during the upload, so the placeholder is not necessarily still where it was.
 * Search once near its original position, and give up on the replacement if it is not found (the content has been changed by the user, so do not insert blindly).
 */
function replacePlaceholder(
  view: EditorView,
  hintFrom: number,
  placeholder: string,
  replacement: string,
): void {
  const doc = view.state.doc.toString()
  const searchFrom = Math.max(0, hintFrom - placeholder.length)
  const found = doc.indexOf(placeholder, searchFrom)
  if (found < 0) return
  view.dispatch({ changes: { from: found, to: found + placeholder.length, insert: replacement } })
}
```

Add the upload method to `src/web/api/client.ts`:

```ts
  async uploadAsset(file: File): Promise<{ path: string }> {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/asset', { method: 'POST', body: form })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new ApiError((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`, res.status)
    }
    return (await res.json()) as { path: string }
  },
```

Add the two extensions to `setup.ts`:

```ts
    imageDecorations(),
    pasteImageHandler(async (file) => (await api.uploadAsset(file)).path),
```

- [ ] **Step 8: Run the whole test suite and confirm it passes**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS, every frontend and backend case green

- [ ] **Step 9: Verify by hand and commit**

Take a screenshot and Ctrl+V in the editor, confirming: the placeholder appears first, then becomes `![](assets/xxxx.png)`, the image displays in place, and `git status` shows the newly added assets file.

```bash
git add package.json src/server src/web tests
git commit -m "feat(editor): render images inline and upload pasted screenshots to assets/"
```

---

### Task 9: Blockquotes, lists, and horizontal rules

**Files:**
- Create: `src/web/editor/live/blocks-misc.ts`, `src/web/editor/live/blocks-misc.css`
- Test: `tests/web/editor/blocks-misc.test.ts`

**Interfaces:**
- Consumes: the Task 1 and Task 4 exports
- Produces: `export function quoteAndListDecorations(): Extension`、`export function ruleDecorations(): Extension`

- Blockquotes: each line gets an `ink-quote` line class (the grey line on the left is drawn by CSS `border-left`), and the `>` marker is hidden when the cursor is elsewhere.
- Lists: the bullet `-`/`*`/`+` is replaced with `•`; ordered list numbers are kept (the user needs to see the numbering).
- Horizontal rules: a `---` line is replaced wholesale with an `<hr>` widget.

- [ ] **Step 1: Write the failing tests**

`tests/web/editor/blocks-misc.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import {
  quoteAndListDecorations,
  ruleDecorations,
} from '../../../src/web/editor/live/blocks-misc.js'
import { readDecorations, stateWithCursor, withView } from '../../../src/web/editor/live/testing.js'

const EXT = [markdown(), quoteAndListDecorations(), ruleDecorations()]

function decosFor(doc: string) {
  return withView(stateWithCursor(doc, EXT), (view) => readDecorations(view))
}

describe('blockquotes', () => {
  it('each line carries the ink-quote line class', () => {
    const decos = decosFor('> line one\n> line two\n\n|end')
    expect(decos.filter((d) => d.class === 'ink-quote')).toHaveLength(2)
  })

  it('hides the > marker when the cursor is elsewhere', () => {
    const decos = decosFor('> quoted\n\n|end')
    expect(decos).toContainEqual({ from: 0, to: 2, kind: 'replace' })
  })

  it('reveals the > when the cursor is inside the blockquote', () => {
    const decos = decosFor('> quo|ted')
    expect(decos.some((d) => d.kind === 'replace')).toBe(false)
  })

  it('keeps the line class even when the cursor is inside the blockquote', () => {
    const decos = decosFor('> quo|ted')
    expect(decos.some((d) => d.class === 'ink-quote')).toBe(true)
  })
})

describe('unordered lists', () => {
  it('the bullet is replaced by a dot widget', () => {
    const decos = decosFor('- item one\n- item two\n\n|end')
    expect(decos.filter((d) => d.widget === 'BulletWidget')).toHaveLength(2)
  })

  it('reveals the original marker when the cursor is in that item', () => {
    const decos = decosFor('- it|em one\n- item two')
    expect(decos.filter((d) => d.widget === 'BulletWidget')).toHaveLength(1)
  })

  it('* and + are handled the same way', () => {
    expect(decosFor('* a\n\n|end').some((d) => d.widget === 'BulletWidget')).toBe(true)
    expect(decosFor('+ a\n\n|end').some((d) => d.widget === 'BulletWidget')).toBe(true)
  })
})

describe('ordered lists', () => {
  it('the numbering is kept and not replaced', () => {
    const decos = decosFor('1. first\n2. second\n\n|end')
    expect(decos.some((d) => d.widget === 'BulletWidget')).toBe(false)
  })

  it('each item carries the ink-ordered line class', () => {
    const decos = decosFor('1. first\n\n|end')
    expect(decos.some((d) => d.class === 'ink-ordered')).toBe(true)
  })
})

describe('horizontal rules', () => {
  it('--- is replaced by RuleWidget', () => {
    const decos = decosFor('para\n\n---\n\n|end')
    expect(decos.some((d) => d.widget === 'RuleWidget')).toBe(true)
  })

  it('*** is handled the same way', () => {
    const decos = decosFor('para\n\n***\n\n|end')
    expect(decos.some((d) => d.widget === 'RuleWidget')).toBe(true)
  })

  it('reveals the source when the cursor is on that line', () => {
    const decos = decosFor('para\n\n-|--\n\nend')
    expect(decos.some((d) => d.widget === 'RuleWidget')).toBe(false)
  })

  it('renders an hr element', async () => {
    const { RuleWidget } = await import('../../../src/web/editor/live/blocks-misc.js')
    expect(new RuleWidget('---').toDOM().querySelector('hr')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/editor/blocks-misc.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement blocks-misc.ts**

```ts
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { blockDecorations, type BlockRule } from './block.js'
import { CachedWidget } from './CachedWidget.js'
import { buildSet, hideMark, selectionTouches } from './shared.js'

const quoteLine = Decoration.line({ class: 'ink-quote' })
const orderedLine = Decoration.line({ class: 'ink-ordered' })
const bulletLine = Decoration.line({ class: 'ink-bullet' })

export class BulletWidget extends CachedWidget {
  protected render(container: HTMLElement): void {
    container.className = 'ink-bullet-mark'
    container.textContent = '•'
  }

  override get estimatedHeight(): number {
    return -1
  }
}

export class RuleWidget extends CachedWidget {
  protected render(container: HTMLElement): void {
    container.classList.add('ink-rule-block')
    container.append(document.createElement('hr'))
  }
}

function compute(state: EditorState): DecorationSet {
  const ranges: Array<Range<Decoration>> = []

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Blockquote') {
        const first = state.doc.lineAt(node.from).number
        const last = state.doc.lineAt(node.to).number
        for (let n = first; n <= last; n += 1) {
          ranges.push(quoteLine.range(state.doc.line(n).from))
        }
        if (selectionTouches(state, node.from, node.to)) return
        // hide the > and the space after it on every line
        for (let n = first; n <= last; n += 1) {
          const line = state.doc.line(n)
          const match = /^\s*>\s?/.exec(line.text)
          if (match) ranges.push(hideMark.range(line.from, line.from + match[0].length))
        }
        return
      }

      if (node.name !== 'ListItem') return

      const line = state.doc.lineAt(node.from)
      const mark = node.node.firstChild
      if (!mark || mark.name !== 'ListMark') return

      const markText = state.doc.sliceString(mark.from, mark.to)
      const ordered = /\d/.test(markText)

      ranges.push((ordered ? orderedLine : bulletLine).range(line.from))

      // an ordered list's numbering must be kept — it carries information
      if (ordered) return
      if (selectionTouches(state, node.from, node.to)) return

      ranges.push(
        Decoration.replace({ widget: new BulletWidget(markText) }).range(mark.from, mark.to),
      )
    },
  })

  return buildSet(ranges)
}

const miscField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (value, tr) => {
    if (!tr.docChanged && !tr.selection) return value
    return compute(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

const miscAtomic = EditorView.atomicRanges.of((view) => {
  const set = view.state.field(miscField, false)
  if (!set) return Decoration.none
  const hidden: Array<Range<Decoration>> = []
  const iter = set.iter()
  while (iter.value) {
    if (iter.to > iter.from) hidden.push(hideMark.range(iter.from, iter.to))
    iter.next()
  }
  return buildSet(hidden)
})

export function quoteAndListDecorations(): Extension {
  return [miscField, miscAtomic]
}

const ruleRule: BlockRule = {
  nodes: ['HorizontalRule'],
  build: (node, state) => new RuleWidget(state.doc.sliceString(node.from, node.to)),
}

export function ruleDecorations(): Extension {
  return blockDecorations([ruleRule])
}
```

- [ ] **Step 4: Write blocks-misc.css**

```css
.ink-quote {
  border-left: 4px solid var(--ink-rule);
  padding-left: 12px;
  color: var(--ink-fg-muted);
}

.ink-bullet,
.ink-ordered {
  padding-left: 4px;
}

.ink-bullet-mark {
  display: inline-block;
  width: 1em;
  color: var(--ink-fg-muted);
}

.ink-rule-block hr {
  border: none;
  border-top: 1px solid var(--ink-rule);
  margin: 1.5em 0;
}
```

The grey line to the left of a blockquote is a `border-left` — the design document's second deliberate exception to "no borders as separators": a blockquote's left line is part of the typographic semantics, not a layout divider.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/editor/blocks-misc.test.ts`
Expected: PASS, all 13 cases green

- [ ] **Step 6: Wire it up and commit**

```bash
git add src/web/editor/live/blocks-misc.ts src/web/editor/live/blocks-misc.css src/web/editor/setup.ts tests/web/editor/blocks-misc.test.ts
git commit -m "feat(editor): style blockquotes, lists, and horizontal rules"
```

---

### Task 10: Tables

Per the design document's trade-off, the MVP does not do visual table editing. What this task does is make source-mode tables easy to read and edit: column alignment coloring, Tab to move between cells, and auto-completing the separator row as it is typed.

**Files:**
- Create: `src/web/editor/live/table.ts`, `src/web/editor/live/table.css`
- Test: `tests/web/editor/table.test.ts`

**Interfaces:**
- Consumes: Task 1's exports
- Produces: `export function tableDecorations(): Extension`、`export const tableKeymap: Extension`

- [ ] **Step 1: Write the failing table tests**

`tests/web/editor/table.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  nextCell,
  prevCell,
  tableDecorations,
  tableKeymap,
} from '../../../src/web/editor/live/table.js'
import { readDecorations, stateWithCursor, withView } from '../../../src/web/editor/live/testing.js'

const EXT = [markdown(), tableDecorations(), tableKeymap]

function decosFor(doc: string) {
  return withView(stateWithCursor(doc, EXT), (view) => readDecorations(view))
}

const TABLE = '| A | B |\n| --- | --- |\n| 1 | 2 |'

describe('table decorations', () => {
  it('the header row carries the ink-table-header line class', () => {
    const decos = decosFor(`${TABLE}\n\n|end`)
    expect(decos.some((d) => d.class === 'ink-table-header')).toBe(true)
  })

  it('the separator row carries the ink-table-delim line class', () => {
    const decos = decosFor(`${TABLE}\n\n|end`)
    expect(decos.some((d) => d.class === 'ink-table-delim')).toBe(true)
  })

  it('data rows carry the ink-table-row line class', () => {
    const decos = decosFor(`${TABLE}\n\n|end`)
    expect(decos.filter((d) => d.class === 'ink-table-row')).toHaveLength(1)
  })

  it('pipes carry the ink-table-pipe class', () => {
    const decos = decosFor(`${TABLE}\n\n|end`)
    expect(decos.some((d) => d.class === 'ink-table-pipe')).toBe(true)
  })

  it('the decorations remain when the cursor is inside the table (tables are always in source mode)', () => {
    const decos = decosFor('| A | B |\n| --- | --- |\n| 1| | 2 |')
    expect(decos.some((d) => d.class === 'ink-table-header')).toBe(true)
  })

  it('non-table text produces no decorations', () => {
    expect(decosFor('|a | b without table')).toEqual([])
  })
})

describe('Tab cell navigation', () => {
  function pressTab(doc: string, cursor: number, shift = false): number {
    const state = EditorState.create({
      doc,
      extensions: EXT,
      selection: EditorSelection.cursor(cursor),
    })
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ state, parent })
    try {
      // call the exported command directly, bypassing real key dispatch — the command itself is the unit under test
      ;(shift ? prevCell : nextCell)(view)
      return view.state.selection.main.head
    } finally {
      view.destroy()
      parent.remove()
    }
  }

  it('Tab moves to the next cell', () => {
    // in '| A | B |', A is at position 2 and B at 6
    expect(pressTab(TABLE, 2)).toBe(6)
  })

  it('Tab at the end of a row moves to the first cell of the next row', () => {
    // B is at 6, the next row is the separator row, whose first cell is at 12
    expect(pressTab(TABLE, 6)).toBeGreaterThan(9)
  })

  it('Shift-Tab moves back to the previous cell', () => {
    expect(pressTab(TABLE, 6, true)).toBe(2)
  })

  it('Tab outside a table does not move the cursor (left to the default behaviour)', () => {
    expect(pressTab('plain text', 3)).toBe(3)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/editor/table.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement table.ts**

```ts
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import { buildSet } from './shared.js'

const headerLine = Decoration.line({ class: 'ink-table-header' })
const delimLine = Decoration.line({ class: 'ink-table-delim' })
const rowLine = Decoration.line({ class: 'ink-table-row' })
const pipeMark = Decoration.mark({ class: 'ink-table-pipe' })

function compute(state: EditorState): DecorationSet {
  const ranges: Array<Range<Decoration>> = []

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return

      const first = state.doc.lineAt(node.from).number
      const last = state.doc.lineAt(node.to).number

      for (let n = first; n <= last; n += 1) {
        const line = state.doc.line(n)
        const kind = n === first ? headerLine : n === first + 1 ? delimLine : rowLine
        ranges.push(kind.range(line.from))

        // give each | its own class, so the column boundaries recede visually
        for (let i = 0; i < line.text.length; i += 1) {
          if (line.text[i] === '|') {
            ranges.push(pipeMark.range(line.from + i, line.from + i + 1))
          }
        }
      }
    },
  })

  return buildSet(ranges)
}

const tableField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (value, tr) => (tr.docChanged ? compute(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
})

/** Whether the current line is a table row. */
function inTable(state: EditorState, pos: number): boolean {
  let found = false
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter: (node) => {
      if (node.name === 'Table') found = true
    },
  })
  return found
}

/** Returns the start offsets (relative to the document) of every cell's content in a row. */
function cellStarts(state: EditorState, linePos: number): number[] {
  const line = state.doc.lineAt(linePos)
  const starts: number[] = []
  let inCell = false

  for (let i = 0; i < line.text.length; i += 1) {
    if (line.text[i] === '|') {
      inCell = true
      continue
    }
    if (inCell && line.text[i] !== ' ') {
      starts.push(line.from + i)
      inCell = false
    }
  }
  return starts
}

export function nextCell(view: EditorView): boolean {
  return moveCell(view, 1)
}

export function prevCell(view: EditorView): boolean {
  return moveCell(view, -1)
}

function moveCell(view: EditorView, direction: 1 | -1): boolean {
  const state = view.state
  const pos = state.selection.main.head
  if (!inTable(state, pos)) return false

  const starts = cellStarts(state, pos)
  const index = starts.findIndex((s) => s >= pos)
  const currentIndex = index === -1 ? starts.length - 1 : starts[index] === pos ? index : index - 1

  const target = currentIndex + direction
  if (target >= 0 && target < starts.length) {
    view.dispatch({ selection: { anchor: starts[target]! } })
    return true
  }

  // across rows: down to the first cell of the next row, up to the last cell of the previous one
  const line = state.doc.lineAt(pos)
  const nextLineNumber = line.number + direction
  if (nextLineNumber < 1 || nextLineNumber > state.doc.lines) return false

  const nextLine = state.doc.line(nextLineNumber)
  if (!inTable(state, nextLine.from)) return false

  const nextStarts = cellStarts(state, nextLine.from)
  if (nextStarts.length === 0) return false

  view.dispatch({
    selection: { anchor: direction === 1 ? nextStarts[0]! : nextStarts[nextStarts.length - 1]! },
  })
  return true
}

export const tableKeymap: Extension = keymap.of([
  { key: 'Tab', run: nextCell },
  { key: 'Shift-Tab', run: prevCell },
])

export function tableDecorations(): Extension {
  return [tableField]
}
```

The two commands in `tableKeymap` return `false` outside a table, and CM6 then keeps dispatching down to `defaultKeymap`'s Tab handler — so `tableKeymap` must come **before** `defaultKeymap`.

- [ ] **Step 4: Write table.css**

```css
.ink-table-header,
.ink-table-delim,
.ink-table-row {
  font-family: var(--ink-font-mono);
  font-size: 0.92em;
  background: var(--ink-code-bg);
  padding-left: 12px;
  padding-right: 12px;
}

.ink-table-header {
  font-weight: 600;
  padding-top: 8px;
}

.ink-table-delim {
  color: var(--ink-fg-muted);
}

.ink-table-pipe {
  color: var(--ink-rule);
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/editor/table.test.ts`
Expected: PASS, all 10 cases green

- [ ] **Step 6: Wire it up and commit**

Both `tableDecorations()` and `tableKeymap` go into `setup.ts`, with `tableKeymap` placed before `keymap.of([...defaultKeymap])`.

```bash
git add src/web/editor/live/table.ts src/web/editor/live/table.css src/web/editor/setup.ts tests/web/editor/table.test.ts
git commit -m "feat(editor): add table column styling and tab cell navigation"
```

---

### Task 11: Input feel

Half of Typora's experience is here. Each rule is independent — implement and test them one at a time.

**Files:**
- Create: `src/web/editor/input.ts`
- Test: `tests/web/editor/input.test.ts`

**Interfaces:**
- Consumes: `@codemirror/state`、`@codemirror/view`、`@codemirror/commands`
- Produces: `export const markdownInputKeymap: Extension`、`export const autoPairs: Extension`

The rule list:

| Trigger | Behaviour |
|---|---|
| Enter at the end of a list item | Insert a newline and continue the same list marker; an ordered list's number increments |
| Enter on an empty list item | Delete the marker and exit the list |
| Tab at the start of a list item | Indent that item by two spaces |
| Shift-Tab at the start of a list item | Outdent that item by one level |
| Typing `*`, `` ` ``, `$`, `_` | Wrap the selection if there is one; otherwise do not auto-pair (to avoid interrupting CJK input) |
| Pasting a URL over selected text | Becomes `[selected text](URL)` |

- [ ] **Step 1: Write the failing input tests**

`tests/web/editor/input.test.ts`：

```ts
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  continueList,
  indentListItem,
  outdentListItem,
  wrapSelection,
} from '../../../src/web/editor/input.js'

function makeView(doc: string, anchor: number, head = anchor): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdown()],
      selection: EditorSelection.range(anchor, head),
    }),
    parent,
  })
}

function run(view: EditorView, command: (v: EditorView) => boolean): string {
  command(view)
  const result = view.state.doc.toString()
  view.destroy()
  return result
}

describe('list continuation', () => {
  it('Enter at the end of an unordered item continues with - ', () => {
    const view = makeView('- item', 6)
    expect(run(view, continueList)).toBe('- item\n- ')
  })

  it('an ordered list\'s number increments', () => {
    const view = makeView('1. first', 8)
    expect(run(view, continueList)).toBe('1. first\n2. ')
  })

  it('preserves the indentation', () => {
    const view = makeView('  - nested', 10)
    expect(run(view, continueList)).toBe('  - nested\n  - ')
  })

  it('Enter on an empty list item deletes the marker and exits the list', () => {
    const view = makeView('- item\n- ', 9)
    expect(run(view, continueList)).toBe('- item\n')
  })

  it('an empty ordered item exits the same way', () => {
    const view = makeView('1. a\n2. ', 8)
    expect(run(view, continueList)).toBe('1. a\n')
  })

  it('returns false on a non-list line, leaving Enter to the default', () => {
    const view = makeView('plain', 5)
    expect(continueList(view)).toBe(false)
    view.destroy()
  })

  it('a list inside a blockquote continues too', () => {
    const view = makeView('> - item', 8)
    expect(run(view, continueList)).toBe('> - item\n> - ')
  })
})

describe('list indentation', () => {
  it('Tab indents by two spaces', () => {
    const view = makeView('- item', 3)
    expect(run(view, indentListItem)).toBe('  - item')
  })

  it('Shift-Tab reduces the indentation', () => {
    const view = makeView('  - item', 5)
    expect(run(view, outdentListItem)).toBe('- item')
  })

  it('Shift-Tab at the leftmost level changes nothing', () => {
    const view = makeView('- item', 3)
    expect(run(view, outdentListItem)).toBe('- item')
  })

  it('Tab on a non-list line returns false', () => {
    const view = makeView('plain', 3)
    expect(indentListItem(view)).toBe(false)
    view.destroy()
  })
})

describe('wrapping the selection', () => {
  it('typing * over selected text wraps it in italics', () => {
    const view = makeView('hello world', 0, 5)
    wrapSelection(view, '*')
    const doc = view.state.doc.toString()
    view.destroy()
    expect(doc).toBe('*hello* world')
  })

  it('the selection still covers the original text after wrapping', () => {
    const view = makeView('hello world', 0, 5)
    wrapSelection(view, '*')
    const sel = view.state.selection.main
    view.destroy()
    expect(sel.from).toBe(1)
    expect(sel.to).toBe(6)
  })

  it('returns false with no selection, inserting no paired character', () => {
    const view = makeView('hello', 2)
    const handled = wrapSelection(view, '*')
    const doc = view.state.doc.toString()
    view.destroy()
    expect(handled).toBe(false)
    expect(doc).toBe('hello')
  })

  it('backticks work the same way', () => {
    const view = makeView('code here', 0, 4)
    wrapSelection(view, '`')
    const doc = view.state.doc.toString()
    view.destroy()
    expect(doc).toBe('`code` here')
  })
})
```

"Do not auto-pair with no selection" is deliberate: under a CJK input method, automatically inserting a closing `*` constantly interrupts candidate selection, which costs far more than the one keystroke it saves.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/editor/input.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement input.ts**

```ts
import type { Extension } from '@codemirror/state'
import { EditorSelection } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

/** Matches an optional blockquote prefix plus the indentation, the list marker, and the space after it, at the start of a line. */
const LIST_PATTERN = /^(\s*(?:>\s*)?)([-*+]|\d+[.)])(\s+)(.*)$/

export function continueList(view: EditorView): boolean {
  const { state } = view
  const pos = state.selection.main.head
  const line = state.doc.lineAt(pos)
  const match = LIST_PATTERN.exec(line.text)
  if (!match) return false

  const [, prefix = '', marker = '', spacing = ' ', body = ''] = match

  // an empty list item: delete the marker and exit the list
  if (body.trim().length === 0) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: prefix.trimEnd() },
      selection: { anchor: line.from + prefix.trimEnd().length },
    })
    return true
  }

  const nextMarker = /^\d/.test(marker)
    ? `${Number.parseInt(marker, 10) + 1}${marker.slice(-1)}`
    : marker

  const insert = `\n${prefix}${nextMarker}${spacing}`
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
  })
  return true
}

export function indentListItem(view: EditorView): boolean {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  if (!LIST_PATTERN.test(line.text)) return false

  view.dispatch({
    changes: { from: line.from, insert: '  ' },
    selection: { anchor: state.selection.main.head + 2 },
  })
  return true
}

export function outdentListItem(view: EditorView): boolean {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  if (!LIST_PATTERN.test(line.text)) return false

  const removable = /^ {1,2}/.exec(line.text)
  if (!removable) return true // already at the leftmost level; swallow the key but do not change the document

  const count = removable[0].length
  view.dispatch({
    changes: { from: line.from, to: line.from + count },
    selection: { anchor: Math.max(line.from, state.selection.main.head - count) },
  })
  return true
}

/** Wraps the selection in a delimiter. Returns false with no selection, so the character is inserted normally. */
export function wrapSelection(view: EditorView, delimiter: string): boolean {
  const range = view.state.selection.main
  if (range.empty) return false

  view.dispatch({
    changes: [
      { from: range.from, insert: delimiter },
      { from: range.to, insert: delimiter },
    ],
    selection: EditorSelection.range(
      range.from + delimiter.length,
      range.to + delimiter.length,
    ),
  })
  return true
}

const WRAPPING_CHARS = ['*', '_', '`', '$', '~'] as const

/** Pasting a URL over selected text → [selected text](URL) */
const linkOnPaste = EditorView.domEventHandlers({
  paste(event, view) {
    const text = event.clipboardData?.getData('text/plain')?.trim()
    if (!text) return false
    if (!/^https?:\/\/\S+$/.test(text)) return false

    const range = view.state.selection.main
    if (range.empty) return false

    event.preventDefault()
    const selected = view.state.doc.sliceString(range.from, range.to)
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: `[${selected}](${text})` },
    })
    return true
  },
})

export const autoPairs: Extension = keymap.of(
  WRAPPING_CHARS.map((char) => ({
    key: char,
    run: (view: EditorView) => wrapSelection(view, char),
  })),
)

export const markdownInputKeymap: Extension = [
  keymap.of([
    { key: 'Enter', run: continueList },
    { key: 'Tab', run: indentListItem },
    { key: 'Shift-Tab', run: outdentListItem },
  ]),
  autoPairs,
  linkOnPaste,
]
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/editor/input.test.ts`
Expected: PASS, all 15 cases green

- [ ] **Step 5: Resolve the conflict with the table Tab**

Task 10's `tableKeymap` and this task's `indentListItem` both bind Tab. Both return `false` when they do not apply, so dispatching in order is enough — but the order matters: the table check is stricter (it must be inside a Table node), so it goes first.

Fix the keymap order in `setup.ts` as:

```ts
    tableKeymap,            // Tab inside a table
    markdownInputKeymap,    // Enter/Tab for lists, pairing, pasting links
    keymap.of([saveBinding, ...defaultKeymap, ...historyKeymap]),
```

- [ ] **Step 6: Verify by hand and commit**

Walk through each one in the browser: type `- a` and press Enter to confirm `- ` continues, then Enter again to confirm it exits the list; type `1. a` and Enter to confirm it becomes `2. `; select a run of text and press `*` to confirm it wraps; select text and paste an http URL to confirm it becomes a link.

```bash
git add src/web/editor/input.ts src/web/editor/setup.ts tests/web/editor/input.test.ts
git commit -m "feat(editor): add list continuation, indent, wrap, and paste-as-link input handling"
```

---

### Task 12: Large-file degradation and integration

**Files:**
- Modify: `src/web/editor/setup.ts` (integrate every extension, add the degradation switch)
- Modify: `src/web/editor/Editor.tsx`
- Create: `tests/web/editor/setup.test.ts`
- Modify: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: every preceding task
- Produces: `export const LIVE_PREVIEW_MAX_BYTES: number`、`export function createExtensions(opts: SetupOptions & { livePreview: boolean }): Extension[]`

- [ ] **Step 1: Write the failing integration tests**

`tests/web/editor/setup.test.ts`：

```ts
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  createExtensions,
  LIVE_PREVIEW_MAX_BYTES,
  shouldUseLivePreview,
} from '../../../src/web/editor/setup.js'
import { readDecorations, withView } from '../../../src/web/editor/live/testing.js'

const noop = { onChange: () => {}, onSaveShortcut: () => {} }

describe('shouldUseLivePreview', () => {
  it('enabled for a small document', () => {
    expect(shouldUseLivePreview('# short')).toBe(true)
  })

  it('disabled for a document over the threshold', () => {
    expect(shouldUseLivePreview('x'.repeat(LIVE_PREVIEW_MAX_BYTES + 1))).toBe(false)
  })

  it('still enabled exactly at the threshold', () => {
    expect(shouldUseLivePreview('x'.repeat(LIVE_PREVIEW_MAX_BYTES))).toBe(true)
  })

  it('counts bytes rather than characters (a CJK character is 3 bytes)', () => {
    const chineseChars = Math.floor(LIVE_PREVIEW_MAX_BYTES / 3) + 100
    expect(shouldUseLivePreview('\u4e2d'.repeat(cjkChars))).toBe(false)
  })
})

describe('createExtensions', () => {
  it('produces live-preview decorations when livePreview is true', () => {
    const state = EditorState.create({
      doc: '# heading\n\n**bold**',
      extensions: createExtensions({ ...noop, livePreview: true }),
    })
    const decos = withView(state, (view) => readDecorations(view))
    expect(decos.some((d) => d.class === 'ink-h1')).toBe(true)
    expect(decos.some((d) => d.class === 'ink-strong')).toBe(true)
  })

  it('produces no live-preview decorations when livePreview is false', () => {
    const state = EditorState.create({
      doc: '# heading\n\n**bold**',
      extensions: createExtensions({ ...noop, livePreview: false }),
    })
    const decos = withView(state, (view) => readDecorations(view))
    expect(decos.some((d) => d.class === 'ink-h1')).toBe(false)
    expect(decos.some((d) => d.class === 'ink-strong')).toBe(false)
  })

  it('editing still works with live preview disabled (onChange is still called)', () => {
    let changed = ''
    const state = EditorState.create({
      doc: 'start',
      extensions: createExtensions({
        onChange: (v) => { changed = v },
        onSaveShortcut: () => {},
        livePreview: false,
      }),
    })
    withView(state, (view) => {
      view.dispatch({ changes: { from: 5, insert: '!' } })
    })
    expect(changed).toBe('start!')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/editor/setup.test.ts`
Expected: FAIL, `shouldUseLivePreview` is not exported

- [ ] **Step 3: Rewrite setup.ts to integrate every extension**

```ts
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, keymap } from '@codemirror/view'
import { api } from '../api/client.js'
import { markdownInputKeymap } from './input.js'
import { quoteAndListDecorations, ruleDecorations } from './live/blocks-misc.js'
import { codeDecorations } from './live/code.js'
import { headingDecorations } from './live/headings.js'
import { imageDecorations } from './live/images.js'
import { inlineDecorations } from './live/inline.js'
import { linkDecorations } from './live/links.js'
import { mathDecorations, mathMarkdownExtension } from './live/math.js'
import { mermaidDecorations } from './live/mermaid.js'
import { tableDecorations, tableKeymap } from './live/table.js'
import { pasteImageHandler } from './paste.js'

import './live/block.css'
import './live/blocks-misc.css'
import './live/code.css'
import './live/headings.css'
import './live/images.css'
import './live/inline.css'
import './live/links.css'
import './live/math.css'
import './live/mermaid.css'
import './live/table.css'

/** Past this size, live preview is turned off — the cost of walking the syntax tree and rendering widgets would crush the editing experience. */
export const LIVE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024

export function shouldUseLivePreview(doc: string): boolean {
  return new TextEncoder().encode(doc).length <= LIVE_PREVIEW_MAX_BYTES
}

const inkstoneTheme = EditorView.theme({
  '&': {
    fontSize: 'var(--ink-font-size)',
    color: 'var(--ink-fg)',
    backgroundColor: 'var(--ink-bg)',
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: 'var(--ink-font-body)',
    lineHeight: 'var(--ink-line-height)',
    overflow: 'auto',
  },
  '.cm-content': {
    maxWidth: 'var(--ink-content-width)',
    margin: '0 auto',
    padding: '30px 30px 100px',
    caretColor: 'var(--ink-fg)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--ink-selection)' },
  '.cm-cursor': { borderLeftColor: 'var(--ink-fg)' },
})

export interface SetupOptions {
  onChange: (value: string) => void
  onSaveShortcut: () => void
  livePreview: boolean
}

/** Every live-preview extension. The order is meaningful; see each task's notes. */
function livePreviewExtensions(): Extension[] {
  return [
    headingDecorations(),
    inlineDecorations(),
    linkDecorations(),
    quoteAndListDecorations(),
    codeDecorations(),
    mermaidDecorations(),
    mathDecorations(),
    imageDecorations(),
    ruleDecorations(),
    tableDecorations(),
    pasteImageHandler(async (file) => (await api.uploadAsset(file)).path),
  ]
}

export function createExtensions(opts: SetupOptions): Extension[] {
  return [
    history(),
    drawSelection(),
    markdown({ codeLanguages: languages, extensions: [mathMarkdownExtension] }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    inkstoneTheme,
    EditorView.lineWrapping,
    ...(opts.livePreview ? livePreviewExtensions() : []),
    tableKeymap,
    markdownInputKeymap,
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          opts.onSaveShortcut()
          return true
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString())
    }),
  ]
}

export function createState(doc: string, opts: Omit<SetupOptions, 'livePreview'>): EditorState {
  return EditorState.create({
    doc,
    extensions: createExtensions({ ...opts, livePreview: shouldUseLivePreview(doc) }),
  })
}
```

This file does not import `blockDecorations` directly — each block extension calls it internally.

- [ ] **Step 4: Make Editor.tsx rebuild state when switching files**

`Editor.tsx` currently replaces the document content with a `dispatch`, but the degradation switch is decided at `EditorState.create` time — switching from a small file to a 3MB one has to change the extension set. Change it to rebuild the whole state on a file switch:

```tsx
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const next = content.value
    if (view.state.doc.toString() === next) return

    // switching files (the path changed) → rebuild state, so the live-preview switch is re-decided for the new document's size
    if (view.state.doc.toString() !== next && lastPathRef.current !== currentPath.value) {
      lastPathRef.current = currentPath.value
      view.setState(
        createState(next, { onChange: editContent, onSaveShortcut: () => void flushSave() }),
      )
      return
    }

    // an external change to the same file → swap only the content, preserving undo history and scroll position
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
  }, [content.value, currentPath.value])
```

Add `const lastPathRef = useRef<string | null>(null)` at the top of the component.

Also add a degradation notice: when `shouldUseLivePreview(content.value)` is false, show a line of explanation above the editor.

```tsx
  const degraded = !shouldUseLivePreview(content.value)
  return (
    <>
      {degraded && (
        <div class="ink-degraded">The file is over 2MB, so live preview has been turned off to keep editing responsive.</div>
      )}
      <div class="ink-editor" ref={hostRef} />
    </>
  )
```

Add to `editor.css`:

```css
.ink-degraded {
  padding: 6px 16px;
  background: var(--ink-code-bg);
  color: var(--ink-fg-muted);
  font-size: 13px;
}
```

- [ ] **Step 5: Run the whole test suite**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS, every unit test and the typecheck pass

- [ ] **Step 6: Extend the end-to-end smoke test**

Append to `tests/e2e/smoke.spec.ts`:

```ts
test('live preview: markers hide when the cursor moves away and reappear when it returns', async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()

  await page.getByText('notes').click()
  await page.getByText('hello.md').click()

  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('## Heading\n\nthis has **bold** text\n\na plain paragraph')

  // the cursor rests on the last line, so the heading line and the bold run should already be rendered
  await expect(page.locator('.ink-h2')).toBeVisible()
  await expect(page.locator('.ink-strong')).toHaveText('bold')
  await expect(editor).not.toContainText('##')

  // click back onto the heading line and the # should reappear
  await page.locator('.ink-h2').click()
  await expect(editor).toContainText('## Heading')
})

test('code blocks render as monospace on a light background', async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.getByText('notes').click()
  await page.getByText('hello.md').click()

  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('```js\nconst a = 1\n```\n\nafter')

  await expect(page.locator('.ink-code-line').first()).toBeVisible()
})
```

Run: `pnpm build && pnpm exec playwright test`
Expected: 4 cases PASS

- [ ] **Step 7: Commit**

```bash
git add src/web/editor tests/web/editor/setup.test.ts tests/e2e/smoke.spec.ts
git commit -m "feat(editor): wire up all live preview extensions with large-file fallback"
```

---

## Phase 1 completion criteria

- [ ] `pnpm typecheck` reports no errors
- [ ] `pnpm test` all green
- [ ] `pnpm test:e2e` all green (4 cases)
- [ ] Manual check: headings, bold, italic, inline code, strikethrough, and links render once the cursor moves away and reveal their source when it returns
- [ ] Manual check: `$$` blocks render as formulas and Mermaid blocks as diagrams, with no stutter while typing continuously
- [ ] Manual check: Ctrl+V on a screenshot displays the image in place and a new file appears under `assets/`
- [ ] Manual check: Enter continues a list, Enter on an empty item exits it, and Tab indents
- [ ] Manual check: opening a >2MB markdown file shows the degradation notice and editing stays responsive
- [ ] Manual check: typing 20 characters in a row inside a Mermaid block produces no perceptible stutter (evidence the cache is working)
