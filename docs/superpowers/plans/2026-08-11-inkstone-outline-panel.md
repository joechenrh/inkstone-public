# Outline Panel and Sidebar Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the left sidebar into a switchable file-tree / document-outline panel that runs the full height of the window, move the git controls into its footer, shrink the status bar to the editor column, and retire the right drawer from outline duty.

**Architecture:** A pure `readOutline(root)` reads headings straight out of Vditor's IR DOM; an `OutlinePanel` renders them, jumps by scroll-container rect deltas, and tracks the active heading on a rAF-throttled scroll listener. A `sidebarView` signal picks which view the sidebar shows, driven by two header buttons and `Cmd/Ctrl+1` / `Cmd/Ctrl+2`. `.ink-shell` becomes a grid whose left column spans the body and status rows.

**Tech Stack:** Preact + @preact/signals; Vditor 3.11.x (IR mode); Vitest (web/jsdom) + Playwright.

## Global Constraints

- TypeScript `strict: true`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, no `any`, relative imports carry `.js`.
- Code, comments, UI strings, and tests are **English only**. The repo currently has zero Chinese characters across all tracked files; keep it that way.
- Colors live only in `src/web/theme/tokens.css`. The Lapis content theme is self-contained in `lapis-theme.css` and must not leak into tokens.css. Introduce no new color values in this plan — reuse existing tokens.
- Panes are separated by a 1px `--ink-rule` hairline, never by a different fill. Every shell surface shares `--ink-bg`.
- Vditor sets `padding` **inline** on `.vditor-reset` in IR mode; overriding it requires author `!important`.
- Testing: Vitest is split into `web` (jsdom) and `server` (node) projects and **must be run per project** — `pnpm vitest run --project web`, then `--project server`. A combined run is unreliable. Playwright runs against a real build with `workers: 1`.
- Do not use heading `id` attributes as identity: Vditor derives them from heading text, so they change when the heading is edited.
- One commit per task, Conventional Commits prefix.

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/web/outline/outline.ts` | `OutlineItem` type + pure `readOutline()` | Create |
| `src/web/outline/OutlinePanel.tsx` | Renders the outline list, handles jump and active tracking | Create |
| `src/web/outline/outline.css` | Outline row styling | Create |
| `src/web/layout/Sidebar.tsx` | Switcher header + active view + git footer | Create |
| `src/web/layout/GitFooter.tsx` | Branch, dirty dot, commit, push — moved out of StatusBar | Create |
| `src/web/state/shortcuts.ts` | `handleShortcut()` — all global key handling, testable | Create |
| `src/web/state/ui.ts` | Add `sidebarView` + `setSidebarView` | Modify |
| `src/web/components/icons.tsx` | Add `IconFiles`/`IconOutline`, redraw `IconNewFile`/`IconNewFolder` | Modify |
| `src/web/layout/Shell.tsx` | Sidebar spans body + status rows | Modify |
| `src/web/layout/shell.css` | Grid restructure, git footer, switcher header | Modify |
| `src/web/layout/StatusBar.tsx` | Reduced to word/char counts | Modify |
| `src/web/App.tsx` | Use `handleShortcut`, render `Sidebar` | Modify |
| `src/web/editor/VditorEditor.tsx` | Capture-phase guard for Vditor's edit-mode hotkeys | Modify |
| `src/web/editor/vditor-shell.css` | Simplify the padding formula | Modify |

---

### Task 1: `readOutline` — extract headings from the IR DOM

**Files:**
- Create: `src/web/outline/outline.ts`
- Test: `tests/web/outline.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
```ts
export interface OutlineItem { level: number; text: string; el: HTMLElement }
export function readOutline(root: HTMLElement | null): OutlineItem[]
```

- [ ] **Step 1: Write the failing test**

`tests/web/outline.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readOutline } from '../../src/web/outline/outline.js'

/**
 * Mirrors what Vditor's IR mode actually produces: headings are direct children
 * of .vditor-reset, and the literal "## " lives in a marker span that is hidden
 * visually but still present in textContent.
 */
function makeRoot(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

const h = (tag: string, marker: string, text: string) =>
  `<${tag} class="vditor-ir__node"><span class="vditor-ir__marker vditor-ir__marker--heading">${marker}</span>${text}</${tag}>`

describe('readOutline', () => {
  it('returns one item per heading, with the level from the tag name', () => {
    const root = makeRoot(h('h1', '# ', 'Title') + h('h3', '### ', 'Deep'))
    expect(readOutline(root).map((i) => i.level)).toEqual([1, 3])
  })

  it('strips the marker span from the text', () => {
    const root = makeRoot(h('h2', '## ', 'Conflict handling'))
    expect(readOutline(root)[0]?.text).toBe('Conflict handling')
  })

  it('keeps the live element reference', () => {
    const root = makeRoot(h('h1', '# ', 'Title'))
    expect(readOutline(root)[0]?.el).toBe(root.querySelector('h1'))
  })

  it('skips non-heading children', () => {
    const root = makeRoot('<p>body</p>' + h('h1', '# ', 'Title') + '<pre>code</pre>')
    expect(readOutline(root)).toHaveLength(1)
  })

  it('only looks at direct children, not nested headings', () => {
    const root = makeRoot('<blockquote>' + h('h1', '# ', 'Quoted') + '</blockquote>')
    expect(readOutline(root)).toEqual([])
  })

  it('covers all six levels', () => {
    const root = makeRoot([1, 2, 3, 4, 5, 6].map((n) => h(`h${n}`, '#'.repeat(n) + ' ', `H${n}`)).join(''))
    expect(readOutline(root).map((i) => i.level)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('returns an empty array for a document with no headings', () => {
    expect(readOutline(makeRoot('<p>just text</p>'))).toEqual([])
  })

  it('returns an empty array for a null root', () => {
    expect(readOutline(null)).toEqual([])
  })

  it('gives an empty string for a heading with no text after the marker', () => {
    const root = makeRoot(h('h2', '## ', ''))
    expect(readOutline(root)[0]?.text).toBe('')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run --project web tests/web/outline.test.ts`
Expected: FAIL — `src/web/outline/outline.ts` does not exist

- [ ] **Step 3: Implement `outline.ts`**

```ts
export interface OutlineItem {
  /** 1-6, taken from the heading's tag name. */
  level: number
  /** The heading text with Vditor's "## " marker removed. */
  text: string
  /** The live heading element. Held instead of an id: Vditor derives heading ids
   *  from the heading text, so an id changes the moment the heading is edited. */
  el: HTMLElement
}

const HEADING = /^H[1-6]$/

/**
 * Reads the outline out of Vditor's IR DOM.
 *
 * In IR mode headings are direct children of `.vditor-reset`, so this only walks one
 * level — a heading nested inside a blockquote is not a document-level section and
 * is deliberately skipped.
 */
export function readOutline(root: HTMLElement | null): OutlineItem[] {
  if (!root) return []
  const items: OutlineItem[] = []
  for (const child of Array.from(root.children)) {
    if (!HEADING.test(child.tagName)) continue
    const el = child as HTMLElement
    items.push({ level: Number(el.tagName.charAt(1)), text: headingText(el), el })
  }
  return items
}

/**
 * Vditor keeps the literal "## " in a marker span that is collapsed visually but still
 * present in textContent. Clone, drop the markers, then read the text — mutating the
 * live heading would corrupt the document.
 */
function headingText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  for (const marker of Array.from(clone.querySelectorAll('.vditor-ir__marker'))) {
    marker.remove()
  }
  return (clone.textContent ?? '').trim()
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run --project web tests/web/outline.test.ts`
Expected: PASS, all 9 cases green

- [ ] **Step 5: Commit**

```bash
git add src/web/outline/outline.ts tests/web/outline.test.ts
git commit -m "feat(outline): read the document outline from Vditor's IR DOM"
```

---

### Task 2: `sidebarView` state and the global shortcut handler

**Files:**
- Modify: `src/web/state/ui.ts`
- Create: `src/web/state/shortcuts.ts`
- Modify: `src/web/App.tsx` (replace the inline `onKey` with `handleShortcut`)
- Test: `tests/web/shortcuts.test.ts`

**Interfaces:**
- Consumes: `leftPanelOpen`, `toggleLeftPanel`, `toggleRightPanel` (ui.ts); `flushSave` (document.ts); `refreshGitStatus` (git.ts)
- Produces:
```ts
// ui.ts
export type SidebarView = 'files' | 'outline'
export const sidebarView: Signal<SidebarView>
export function setSidebarView(view: SidebarView): void
// shortcuts.ts
export function handleShortcut(e: KeyboardEvent): boolean   // true when handled
```

- [ ] **Step 1: Write the failing test**

`tests/web/shortcuts.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleShortcut } from '../../src/web/state/shortcuts.js'
import { leftPanelOpen, rightPanelOpen, sidebarView } from '../../src/web/state/ui.js'

function key(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { cancelable: true, ...init })
}

beforeEach(() => {
  leftPanelOpen.value = true
  rightPanelOpen.value = false
  sidebarView.value = 'files'
})

describe('handleShortcut', () => {
  it('ignores keys without Ctrl/Cmd', () => {
    expect(handleShortcut(key({ key: '1' }))).toBe(false)
    expect(sidebarView.value).toBe('files')
  })

  it('Cmd+2 shows the outline', () => {
    expect(handleShortcut(key({ key: '2', metaKey: true }))).toBe(true)
    expect(sidebarView.value).toBe('outline')
  })

  it('Cmd+1 shows the file tree', () => {
    sidebarView.value = 'outline'
    handleShortcut(key({ key: '1', metaKey: true }))
    expect(sidebarView.value).toBe('files')
  })

  it('opens a collapsed sidebar when selecting a view', () => {
    leftPanelOpen.value = false
    handleShortcut(key({ key: '2', ctrlKey: true }))
    expect(leftPanelOpen.value).toBe(true)
    expect(sidebarView.value).toBe('outline')
  })

  // Vditor hard-codes Ctrl/Cmd+Alt+1..6 for heading levels; intercepting them would
  // break heading shortcuts inside the editor.
  it('does not intercept Cmd+Alt+<digit>', () => {
    expect(handleShortcut(key({ key: '1', metaKey: true, altKey: true }))).toBe(false)
    expect(sidebarView.value).toBe('files')
  })

  it('Cmd+\\ toggles the left panel', () => {
    handleShortcut(key({ key: '\\', metaKey: true }))
    expect(leftPanelOpen.value).toBe(false)
  })

  it('Cmd+/ toggles the right panel', () => {
    handleShortcut(key({ key: '/', metaKey: true }))
    expect(rightPanelOpen.value).toBe(true)
  })

  it('calls preventDefault on a handled key', () => {
    const e = key({ key: '2', metaKey: true })
    const spy = vi.spyOn(e, 'preventDefault')
    handleShortcut(e)
    expect(spy).toHaveBeenCalled()
  })

  it('returns false for an unhandled Cmd combination', () => {
    expect(handleShortcut(key({ key: 'q', metaKey: true }))).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run --project web tests/web/shortcuts.test.ts`
Expected: FAIL — neither `shortcuts.ts` nor `sidebarView` exists

- [ ] **Step 3: Add `sidebarView` to `ui.ts`**

Append to `src/web/state/ui.ts`:

```ts
export type SidebarView = 'files' | 'outline'

export const sidebarView = signal<SidebarView>('files')

/** Selects a sidebar view, opening the sidebar first if it is collapsed — otherwise
 *  the shortcut would appear to do nothing. */
export function setSidebarView(view: SidebarView): void {
  sidebarView.value = view
  if (!leftPanelOpen.value) leftPanelOpen.value = true
}
```

- [ ] **Step 4: Create `shortcuts.ts`**

```ts
import { flushSave } from './document.js'
import { refreshGitStatus } from './git.js'
import { setSidebarView, toggleLeftPanel, toggleRightPanel } from './ui.js'

/**
 * All global keyboard shortcuts, in one testable function.
 *
 * Returns true when the event was handled, in which case preventDefault has been called.
 */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false
  // Ctrl/Cmd+Alt+<digit> belongs to Vditor: 1-6 set the heading level and 7-9 switch
  // edit mode. Bail out before the digit cases so those keep working.
  if (e.altKey) return false

  switch (e.key) {
    case '\\':
      toggleLeftPanel()
      break
    case '/':
      toggleRightPanel()
      break
    case '1':
      setSidebarView('files')
      break
    case '2':
      setSidebarView('outline')
      break
    case 's':
    case 'S':
      void flushSave().then(() => { void refreshGitStatus() })
      break
    default:
      return false
  }
  e.preventDefault()
  return true
}
```

- [ ] **Step 5: Use it in `App.tsx`**

In `src/web/App.tsx`, replace the whole inline `onKey` function with:

```ts
    const onKey = (e: KeyboardEvent) => { handleShortcut(e) }
```

Add `import { handleShortcut } from './state/shortcuts.js'`, and remove the now-unused `flushSave`, `toggleLeftPanel`, and `toggleRightPanel` imports (keep `refreshGitStatus` — it is still called in the mount effect, and keep `flushSave` only if another call site remains; run typecheck to confirm).

- [ ] **Step 6: Run the tests, the full web project, and typecheck**

Run: `pnpm vitest run --project web && pnpm typecheck`
Expected: green

- [ ] **Step 7: Commit**

```bash
git add src/web/state/ui.ts src/web/state/shortcuts.ts src/web/App.tsx tests/web/shortcuts.test.ts
git commit -m "feat(ui): add sidebarView state and extract global shortcuts"
```

---

### Task 3: Block Vditor's edit-mode hotkeys

**Files:**
- Modify: `src/web/editor/VditorEditor.tsx`
- Test: `tests/web/vditor-editor.test.tsx` (append)

**Interfaces:**
- Consumes: the existing `hostRef` in `VditorEditor`
- Produces: nothing exported; a capture-phase `keydown` listener on the host element

**Why a capture-phase listener and not the `keydown` option.** Vditor calls `options.keydown(event)` from *inside* its own `keydown` listener on `.vditor-ir` and ignores the return value, then falls through to its own handling in the same call stack (`editorCommonEvent.ts`). It never checks `defaultPrevented`. So neither returning, nor `preventDefault`, nor `stopPropagation` from the option can veto it. A capture-phase listener on the host — an ancestor of `.vditor-ir` — runs strictly earlier, and `stopPropagation()` there stops the event before Vditor's listener is reached.

- [ ] **Step 1: Write the failing test**

Append to `tests/web/vditor-editor.test.tsx`:

```ts
describe('Vditor edit-mode hotkeys', () => {
  // Ctrl/Cmd+Alt+7/8/9 switch Vditor between wysiwyg / ir / sv. This app only supports
  // IR — the Lapis theme and every shell rule are scoped to .vditor-ir — and there is no
  // UI to switch back, so a stray press leaves a broken editor with no recovery.
  it('swallows Cmd+Alt+7/8/9 before they reach Vditor', () => {
    const { container } = render(<VditorEditor />)
    const host = container.querySelector('.ink-editor') as HTMLElement
    for (const code of ['Digit7', 'Digit8', 'Digit9']) {
      const e = new KeyboardEvent('keydown', { code, metaKey: true, altKey: true, cancelable: true, bubbles: true })
      host.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(true)
    }
  })

  it('leaves Cmd+Alt+1..6 alone so heading shortcuts keep working', () => {
    const { container } = render(<VditorEditor />)
    const host = container.querySelector('.ink-editor') as HTMLElement
    for (const code of ['Digit1', 'Digit6']) {
      const e = new KeyboardEvent('keydown', { code, metaKey: true, altKey: true, cancelable: true, bubbles: true })
      host.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run --project web tests/web/vditor-editor.test.tsx`
Expected: FAIL — `defaultPrevented` is false for Digit7/8/9

- [ ] **Step 3: Implement the guard**

In `src/web/editor/VditorEditor.tsx`, inside the mount `useEffect` and **before** `new Vditor(...)`, add:

```tsx
    const host = hostRef.current
    // Vditor hard-codes Ctrl/Cmd+Alt+7/8/9 to switch between wysiwyg / ir / sv modes.
    // This app is IR-only: the Lapis theme and the shell CSS are scoped to .vditor-ir and
    // there is no UI to switch back, so a stray press leaves a broken editor.
    // It has to be a capture-phase listener on the host: Vditor calls options.keydown from
    // inside its own listener on .vditor-ir, ignores the result, and never checks
    // defaultPrevented — so the option cannot veto it, but an ancestor capture listener can.
    const blockEditModeSwitch = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && /^Digit[789]$/.test(e.code)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    host.addEventListener('keydown', blockEditModeSwitch, true)
```

and in the cleanup returned from that effect, before `vd.destroy()`:

```tsx
      host.removeEventListener('keydown', blockEditModeSwitch, true)
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run --project web tests/web/vditor-editor.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/editor/VditorEditor.tsx tests/web/vditor-editor.test.tsx
git commit -m "fix(editor): block Vditor's edit-mode hotkeys, which break the IR-only shell"
```

---

### Task 4: Icon set — switcher pair, redrawn create and row-action icons

**Files:**
- Modify: `src/web/components/icons.tsx`
- Test: `tests/web/icons.test.tsx` (append)

**Interfaces:**
- Produces: `IconFiles`, `IconOutline` (new); `IconNewFile`, `IconNewFolder`, `IconRename`, `IconTrash` (redrawn, same names and props)

**Why they are being redrawn.** Rendered at the sizes actually used — 18px in the sidebar header, 16px in tree row actions — the existing icons break down in three specific ways, and adding a clean switcher pair made all of them visible at once:

- `IconNewFile` / `IconNewFolder` pack four sub-shapes into the box with a 4px-armed `+`, which turns to mush at 18px. They also use corner radius 2 where `IconSidebar` uses 1.5, on a different optical box.
- `IconRename` draws its baseline as a separate `M12 20h9` stroke. At 16px that stroke detaches from the pencil and reads as a stray line rather than part of the glyph.
- `IconTrash` pairs a full-width 3→21 lid with an inward-tapering body, which reads top-heavy at 16px.

All of them now share a 3–21 optical box and radius 1.5, the plus grows to 6px arms, the pencil becomes one closed body with a ferrule line, and the can becomes a straight-sided cylinder with a rounded base.

- [ ] **Step 1: Write the failing test**

Append to `tests/web/icons.test.tsx`:

```tsx
import { IconFiles, IconOutline } from '../../src/web/components/icons.js'

describe('sidebar switcher icons', () => {
  it('IconFiles renders an svg stroked with currentColor', () => {
    const { container } = render(<IconFiles />)
    expect(container.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor')
  })

  it('IconOutline renders an svg stroked with currentColor', () => {
    const { container } = render(<IconOutline />)
    expect(container.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor')
  })

  it('both accept a title for the accessible name', () => {
    const { container } = render(<IconOutline title="Outline" />)
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Outline')
  })

  // The switcher's files glyph and the new-folder action must not be the same shape:
  // they sit next to each other in the sidebar header and would be mis-clicked.
  it('IconFiles is not the same shape as IconNewFolder', () => {
    const files = render(<IconFiles />).container.querySelector('svg')?.innerHTML
    const folder = render(<IconNewFolder />).container.querySelector('svg')?.innerHTML
    expect(files).not.toBe(folder)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run --project web tests/web/icons.test.tsx`
Expected: FAIL — `IconFiles`/`IconOutline` are not exported

- [ ] **Step 3: Add the switcher pair to `icons.tsx`**

```tsx
/** Sidebar switcher: the file view. Overlapping documents — the only stacked silhouette
 *  in the set, so it cannot be confused with the folder used by IconNewFolder. */
export const IconFiles = (p: IconProps) =>
  svg(
    <>
      <rect x="3" y="7" width="13" height="14" rx="1.5" />
      <path d="M7 7V4.5A1.5 1.5 0 0 1 8.5 3H17l4 4v9.5a1.5 1.5 0 0 1-1.5 1.5H16" />
    </>,
    p,
  )

/** Sidebar switcher: the outline view. A staircase of bars reads as hierarchy at 18px,
 *  where a tree glyph with nodes turns to mush. */
export const IconOutline = (p: IconProps) =>
  svg(
    <>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="14" y1="17" x2="20" y2="17" />
    </>,
    p,
  )
```

- [ ] **Step 4: Redraw the create icons**

Replace the existing `IconNewFile` and `IconNewFolder` bodies with:

```tsx
export const IconNewFile = (p: IconProps) =>
  svg(
    <>
      <path d="M13.5 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8.5z" />
      <path d="M13.5 3v5.5H19" />
      <line x1="12" y1="12.5" x2="12" y2="18.5" />
      <line x1="9" y1="15.5" x2="15" y2="15.5" />
    </>,
    p,
  )

export const IconNewFolder = (p: IconProps) =>
  svg(
    <>
      <path d="M3 18.5V6A1.5 1.5 0 0 1 4.5 4.5H9l2 3h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
      <line x1="12" y1="10.5" x2="12" y2="16.5" />
      <line x1="9" y1="13.5" x2="15" y2="13.5" />
    </>,
    p,
  )
```

- [ ] **Step 5: Redraw the row-action icons**

Replace the existing `IconRename` and `IconTrash` bodies with:

```tsx
export const IconRename = (p: IconProps) =>
  svg(
    <>
      <path d="M4 20l1.2-4.2L15.8 5.2a1.8 1.8 0 0 1 2.5 0l.5.5a1.8 1.8 0 0 1 0 2.5L8.2 18.8z" />
      <path d="M14.2 6.8l3 3" />
    </>,
    p,
  )

export const IconTrash = (p: IconProps) =>
  svg(
    <>
      <path d="M4 6.5h16" />
      <path d="M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
      <path d="M6.5 6.5v12A1.5 1.5 0 0 0 8 20h8a1.5 1.5 0 0 0 1.5-1.5v-12" />
    </>,
    p,
  )
```

These render at 16px inside `.ink-tree-actions` (see `filetree.css`), which is why the pencil's separate baseline stroke had to go — at that size it separated from the body.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run --project web tests/web/icons.test.tsx && pnpm typecheck`
Expected: PASS — the existing icon cases still pass, because every props contract is unchanged and the existing assertions check `stroke`, the `ink-icon` class, and class pass-through rather than path data

- [ ] **Step 7: Commit**

```bash
git add src/web/components/icons.tsx tests/web/icons.test.tsx
git commit -m "feat(icons): add sidebar switcher icons, redraw create and row-action icons"
```

---

### Task 5: `OutlinePanel` — render, jump, and active tracking

**Files:**
- Create: `src/web/outline/OutlinePanel.tsx`, `src/web/outline/outline.css`
- Test: `tests/web/outlinepanel.test.tsx`

**Interfaces:**
- Consumes: `readOutline`, `OutlineItem` (Task 1); `content` (document.ts); `currentPath` (vault.ts)
- Produces: `export function OutlinePanel(): VNode`

**Scroll container.** The editor's scroller is `.vditor-ir .vditor-reset` — Vditor gives it `height: 100%` and overflow, so `.vditor-content` never scrolls. Both the jump and the active tracking must target that element.

- [ ] **Step 1: Write the failing test**

`tests/web/outlinepanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import { OutlinePanel } from '../../src/web/outline/OutlinePanel.js'
import { content } from '../../src/web/state/document.js'
import { currentPath } from '../../src/web/state/vault.js'

/** Stands in for the editor: OutlinePanel finds the scroller by selector. */
function mountEditor(headingsHtml: string) {
  const wrap = document.createElement('div')
  wrap.className = 'vditor-ir'
  const reset = document.createElement('pre')
  reset.className = 'vditor-reset'
  reset.innerHTML = headingsHtml
  wrap.appendChild(reset)
  document.body.appendChild(wrap)
  return wrap
}

const h = (tag: string, marker: string, text: string) =>
  `<${tag} class="vditor-ir__node"><span class="vditor-ir__marker vditor-ir__marker--heading">${marker}</span>${text}</${tag}>`

beforeEach(() => {
  document.body.innerHTML = ''
  currentPath.value = 'notes/a.md'
  content.value = '# Title'
})

describe('OutlinePanel', () => {
  it('renders one row per heading', () => {
    mountEditor(h('h1', '# ', 'Title') + h('h2', '## ', 'Section'))
    render(<OutlinePanel />)
    expect(screen.getByText('Title')).toBeTruthy()
    expect(screen.getByText('Section')).toBeTruthy()
  })

  it('marks the depth with a level class so CSS can indent', () => {
    mountEditor(h('h3', '### ', 'Deep'))
    const { container } = render(<OutlinePanel />)
    expect(container.querySelector('.ink-outline-row.ink-outline-l3')).toBeTruthy()
  })

  it('shows an empty state when the document has no headings', () => {
    mountEditor('<p>body only</p>')
    const { container } = render(<OutlinePanel />)
    expect(container.querySelector('.ink-outline-empty')).toBeTruthy()
  })

  it('shows an empty state when no file is open', () => {
    currentPath.value = null
    mountEditor('')
    const { container } = render(<OutlinePanel />)
    expect(container.querySelector('.ink-outline-empty')).toBeTruthy()
  })

  it('renders a placeholder for a heading with no text, keeping the row clickable', () => {
    mountEditor(h('h2', '## ', ''))
    const { container } = render(<OutlinePanel />)
    const row = container.querySelector('.ink-outline-row')
    expect(row).toBeTruthy()
    expect(row?.textContent?.trim()).not.toBe('')
  })

  it('gives each row a title attribute so a truncated heading is readable on hover', () => {
    mountEditor(h('h2', '## ', 'A very long heading that will certainly be truncated'))
    const { container } = render(<OutlinePanel />)
    expect(container.querySelector('.ink-outline-row')?.getAttribute('title'))
      .toBe('A very long heading that will certainly be truncated')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run --project web tests/web/outlinepanel.test.tsx`
Expected: FAIL — the module does not exist

- [ ] **Step 3: Implement `OutlinePanel.tsx`**

```tsx
import { useEffect, useState } from 'preact/hooks'
import { content } from '../state/document.js'
import { currentPath } from '../state/vault.js'
import { readOutline, type OutlineItem } from './outline.js'
import './outline.css'

const SCROLLER = '.vditor-ir .vditor-reset'
/** Distance from the top of the viewport a jumped-to heading comes to rest at. */
const JUMP_OFFSET = 24
/** A heading counts as "current" once its top passes this far down the viewport. */
const ACTIVE_OFFSET = 72

function scroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SCROLLER)
}

export function OutlinePanel() {
  const [items, setItems] = useState<OutlineItem[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)

  // Recompute whenever the document changes. Vditor's input callback is already
  // debounced by ~800ms, so no extra debounce is needed here.
  useEffect(() => {
    setItems(readOutline(scroller()))
  }, [content.value, currentPath.value])

  // Track which heading the reader is currently under. Throttled with rAF: a scroll
  // listener that reads rects on every event forces layout on every frame of a fling.
  useEffect(() => {
    const el = scroller()
    if (!el) return
    let queued = false

    const measure = () => {
      queued = false
      const top = el.getBoundingClientRect().top + ACTIVE_OFFSET
      let current = -1
      items.forEach((item, i) => {
        if (item.el.getBoundingClientRect().top <= top) current = i
      })
      setActiveIndex(current)
    }

    const onScroll = () => {
      if (queued) return
      queued = true
      requestAnimationFrame(measure)
    }

    measure()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll) }
  }, [items])

  function jump(item: OutlineItem) {
    const el = scroller()
    if (!el) return
    const rect = item.el.getBoundingClientRect()
    // A detached heading reports an all-zero rect; scrolling on that would jump to the top.
    if (rect.top === 0 && rect.height === 0) return
    // Rect deltas rather than offsetTop: .vditor-reset is position:static, so a heading's
    // offsetParent is .ink-center and offsetTop would be measured from the wrong origin.
    el.scrollTop += rect.top - el.getBoundingClientRect().top - JUMP_OFFSET
  }

  if (!currentPath.value) {
    return <div class="ink-outline-empty">No file open</div>
  }
  if (items.length === 0) {
    return <div class="ink-outline-empty">No headings in this note</div>
  }

  return (
    <div class="ink-outline" role="tree" aria-label="Outline">
      {items.map((item, i) => (
        <button
          key={`${i}-${item.text}`}
          type="button"
          role="treeitem"
          aria-selected={i === activeIndex}
          class={[
            'ink-outline-row',
            `ink-outline-l${item.level}`,
            i === activeIndex ? 'active' : '',
          ].filter(Boolean).join(' ')}
          title={item.text}
          onClick={() => jump(item)}
        >
          {item.text === '' ? <span class="ink-outline-untitled">Untitled</span> : item.text}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Write `outline.css`**

```css
.ink-outline {
  padding: 4px 0 8px;
  font-size: var(--ink-tree-font-size);
  user-select: none;
}

.ink-outline-row {
  display: block;
  width: 100%;
  height: 26px;
  padding: 0 12px;
  border: none;
  background: none;
  font: inherit;
  color: var(--ink-fg);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.ink-outline-row:hover { background: var(--ink-sidebar-hover); }

/* The active heading takes the Lapis accent, matching the rendered document it points at. */
.ink-outline-row.active {
  color: var(--ink-link);
  font-weight: 600;
}

/* 12px per level rather than the usual 20px: at 260px the deeper levels still need room
   for their text. */
.ink-outline-l2 { padding-left: 24px; }
.ink-outline-l3 { padding-left: 36px; }
.ink-outline-l4 { padding-left: 48px; }
.ink-outline-l5 { padding-left: 60px; }
.ink-outline-l6 { padding-left: 72px; }

.ink-outline-untitled { color: var(--ink-fg-muted); font-style: italic; }

.ink-outline-empty {
  padding: 16px;
  color: var(--ink-fg-muted);
  font-size: var(--ink-tree-font-size);
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run --project web tests/web/outlinepanel.test.tsx && pnpm typecheck`
Expected: PASS, all 6 cases green

Note: jump and active tracking are **not** asserted here. jsdom reports every `getBoundingClientRect()` as zeros, so such a test would assert nothing while appearing to pass. Task 8 covers them in Playwright.

- [ ] **Step 6: Commit**

```bash
git add src/web/outline tests/web/outlinepanel.test.tsx
git commit -m "feat(outline): add the outline panel with jump and active-heading tracking"
```

---

### Task 6: `Sidebar` shell and moving git out of the status bar

**Files:**
- Create: `src/web/layout/Sidebar.tsx`, `src/web/layout/GitFooter.tsx`
- Modify: `src/web/layout/StatusBar.tsx`, `src/web/App.tsx`
- Test: `tests/web/sidebar.test.tsx`; update `tests/web/git-actions.test.tsx`

**Interfaces:**
- Consumes: `sidebarView`, `setSidebarView` (Task 2); `OutlinePanel` (Task 5); `IconFiles`, `IconOutline` (Task 4); `FileTree`; the git state used by the current StatusBar
- Produces:
```tsx
export function Sidebar(props: { onOpenFile: (path: string) => void }): VNode
export function GitFooter(): VNode
export function StatusBar(props: { words: number; chars: number }): VNode  // reduced
```

- [ ] **Step 1: Write the failing test**

`tests/web/sidebar.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from '../../src/web/layout/Sidebar.js'
import { sidebarView } from '../../src/web/state/ui.js'
import { tree } from '../../src/web/state/vault.js'

beforeEach(() => {
  sidebarView.value = 'files'
  tree.value = []
  document.body.innerHTML = ''
})

describe('Sidebar', () => {
  it('shows the file tree by default', () => {
    const { container } = render(<Sidebar onOpenFile={() => {}} />)
    expect(container.querySelector('.ink-tree-container')).toBeTruthy()
    expect(container.querySelector('.ink-outline, .ink-outline-empty')).toBeNull()
  })

  it('shows the outline once the view switches', () => {
    sidebarView.value = 'outline'
    const { container } = render(<Sidebar onOpenFile={() => {}} />)
    expect(container.querySelector('.ink-outline, .ink-outline-empty')).toBeTruthy()
    expect(container.querySelector('.ink-tree-container')).toBeNull()
  })

  it('the switcher buttons change the view', () => {
    render(<Sidebar onOpenFile={() => {}} />)
    fireEvent.click(screen.getByTitle('Outline'))
    expect(sidebarView.value).toBe('outline')
    fireEvent.click(screen.getByTitle('Files'))
    expect(sidebarView.value).toBe('files')
  })

  it('marks the active switcher button with aria-pressed', () => {
    render(<Sidebar onOpenFile={() => {}} />)
    expect(screen.getByTitle('Files').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTitle('Outline').getAttribute('aria-pressed')).toBe('false')
  })

  it('renders the git footer in both views', () => {
    const { container, rerender } = render(<Sidebar onOpenFile={() => {}} />)
    expect(container.querySelector('.ink-git-footer')).toBeTruthy()
    sidebarView.value = 'outline'
    rerender(<Sidebar onOpenFile={() => {}} />)
    expect(container.querySelector('.ink-git-footer')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run --project web tests/web/sidebar.test.tsx`
Expected: FAIL — `Sidebar` does not exist

- [ ] **Step 3: Extract `GitFooter.tsx`**

Move the entire `<span class="ink-git-actions">…</span>` block out of `StatusBar.tsx` into a new component, along with the `confirmPush` state and the four handlers. The markup and behaviour are unchanged; only the wrapper element and class change:

```tsx
import { useState } from 'preact/hooks'
import { IconCommit, IconGitBranch, IconPushArrow } from '../components/icons.js'
import { commitVault, gitBusy, gitError, gitStatus, pushVault } from '../state/git.js'

/** Vault-level git state and actions. These describe the vault — the same thing the
 *  sidebar itself shows — so they live at the bottom of the sidebar rather than in the
 *  status bar, which is scoped to the open document. */
export function GitFooter() {
  const [confirmPush, setConfirmPush] = useState(false)

  const status = gitStatus.value
  const busy = gitBusy.value
  const err = gitError.value
  const isBusy = busy !== 'idle'

  return (
    <div class="ink-git-footer">
      <div class="ink-git-line">
        <span class="ink-git-branch">
          <IconGitBranch size={14} />
          <span class="ink-git-branch-name">{status.branch}</span>
          {status.dirty ? <span class="ink-git-dirty-dot" aria-label="Uncommitted changes" /> : null}
        </span>
        <button
          class="ink-iconbtn ink-commit-btn"
          disabled={!status.dirty || isBusy}
          onClick={() => { void commitVault() }}
          title="Commit"
        >
          <IconCommit size={14} title={busy === 'committing' ? 'Committing…' : 'Commit'} />
        </button>
      </div>
      {status.hasRemote && status.ahead > 0 && !confirmPush && (
        <button class="ink-push-btn" disabled={isBusy} onClick={() => setConfirmPush(true)}>
          <IconPushArrow size={13} />
          {`Push ${status.ahead}`}
        </button>
      )}
      {status.hasRemote && status.ahead > 0 && confirmPush && (
        <span class="ink-push-confirm">
          {`Push ${status.ahead} commit(s) to ${status.branch}?`}
          <button onClick={() => { setConfirmPush(false); void pushVault() }} disabled={isBusy}>Confirm</button>
          <button onClick={() => setConfirmPush(false)}>Cancel</button>
        </span>
      )}
      {err !== null && <span class="ink-git-error">{err}</span>}
    </div>
  )
}
```

- [ ] **Step 4: Reduce `StatusBar.tsx`**

```tsx
export interface StatusBarProps {
  words: number
  chars: number
}

/** Document-level counters. Vault-level git state lives in the sidebar's GitFooter. */
export function StatusBar(props: StatusBarProps) {
  return (
    <span class="ink-statusbar-counts">
      <span>{props.words} words</span>
      <span>{props.chars} chars</span>
    </span>
  )
}
```

Delete the now-unused imports (`useState`, the icons, and the git state).

- [ ] **Step 5: Create `Sidebar.tsx`**

```tsx
import { IconFiles, IconOutline } from '../components/icons.js'
import { FileTree } from '../filetree/FileTree.js'
import { OutlinePanel } from '../outline/OutlinePanel.js'
import { setSidebarView, sidebarView } from '../state/ui.js'
import { GitFooter } from './GitFooter.js'

export interface SidebarProps {
  onOpenFile: (path: string) => void
}

export function Sidebar({ onOpenFile }: SidebarProps) {
  const view = sidebarView.value
  return (
    <div class="ink-sidebar">
      <div class="ink-sidebar-switch">
        <button
          type="button"
          class="ink-sidebar-tab"
          title="Files"
          aria-pressed={view === 'files'}
          onClick={() => setSidebarView('files')}
        >
          <IconFiles />
        </button>
        <button
          type="button"
          class="ink-sidebar-tab"
          title="Outline"
          aria-pressed={view === 'outline'}
          onClick={() => setSidebarView('outline')}
        >
          <IconOutline />
        </button>
      </div>
      <div class="ink-sidebar-view">
        {view === 'files' ? <FileTree onOpenFile={onOpenFile} /> : <OutlinePanel />}
      </div>
      <GitFooter />
    </div>
  )
}
```

- [ ] **Step 6: Wire it into `App.tsx`**

Replace `left={<FileTree onOpenFile={(path) => void openFile(path)} />}` with:

```tsx
      left={<Sidebar onOpenFile={(path) => void openFile(path)} />}
```

Swap the `FileTree` import for `Sidebar`.

- [ ] **Step 7: Update `git-actions.test.tsx`**

That suite renders `<StatusBar words={0} chars={0} />` and asserts on the commit and push controls, which now live in `GitFooter`. Change every `render(<StatusBar words={0} chars={0} />)` to `render(<GitFooter />)` and update the import. The assertions themselves do not change — the markup moved but did not change.

- [ ] **Step 8: Run the full web project and typecheck**

Run: `pnpm vitest run --project web && pnpm typecheck`
Expected: green

- [ ] **Step 9: Commit**

```bash
git add src/web/layout src/web/App.tsx tests/web/sidebar.test.tsx tests/web/git-actions.test.tsx
git commit -m "feat(layout): switchable sidebar with the git controls in its footer"
```

---

### Task 7: Layout restructure

**Files:**
- Modify: `src/web/layout/Shell.tsx`, `src/web/layout/shell.css`, `src/web/editor/vditor-shell.css`
- Test: covered by Task 8's Playwright geometry test

**Interfaces:**
- Consumes: `Sidebar` (Task 6)
- Produces: a grid where the sidebar spans the body and status rows

- [ ] **Step 1: Restructure `Shell.tsx`**

The `.ink-body` wrapper goes away — the sidebar has to be a grid item of `.ink-shell` to span two rows, and a wrapper div would prevent that.

```tsx
import type { ComponentChildren } from 'preact'
import { leftPanelOpen, rightPanelOpen } from '../state/ui.js'
import './shell.css'

export interface ShellProps {
  topBar: ComponentChildren
  left: ComponentChildren
  center: ComponentChildren
  right: ComponentChildren
  statusBar: ComponentChildren
}

export function Shell(props: ShellProps) {
  return (
    <div class={`ink-shell${leftPanelOpen.value ? '' : ' ink-shell--no-left'}`}>
      <header class="ink-topbar">{props.topBar}</header>
      {leftPanelOpen.value && <aside class="ink-left">{props.left}</aside>}
      <main class="ink-center">
        {props.center}
        {rightPanelOpen.value && <aside class="ink-right">{props.right}</aside>}
      </main>
      <footer class="ink-statusbar">{props.statusBar}</footer>
    </div>
  )
}
```

The right drawer moves inside `.ink-center`, which is already its positioning ancestor (`position: relative`), so the drawer keeps working unchanged if Phase 2 ever fills it.

- [ ] **Step 2: Rewrite the grid in `shell.css`**

Replace the `.ink-shell`, `.ink-body`, `.ink-left`, and `.ink-center` rules with:

```css
.ink-shell {
  display: grid;
  grid-template-columns: var(--ink-left-width) 1fr;
  grid-template-rows: var(--ink-topbar-height) 1fr var(--ink-statusbar-height);
  height: 100%;
}

/* With the sidebar collapsed there is one column, and the status bar spans everything. */
.ink-shell--no-left {
  grid-template-columns: 1fr;
}

.ink-topbar {
  grid-column: 1 / -1;
  border-bottom: 1px solid var(--ink-rule);
}

/* The sidebar spans the body AND status rows, running to the bottom of the window.
   The status bar is document-scoped (word counts) and so is confined to the editor
   column; the vault-scoped git controls live in this sidebar's footer instead. */
.ink-left {
  grid-column: 1;
  grid-row: 2 / 4;
  background: var(--ink-sidebar-bg);
  border-right: 1px solid var(--ink-rule);
  overflow: hidden;
  min-height: 0;
}

.ink-shell--no-left .ink-center,
.ink-shell--no-left .ink-statusbar {
  grid-column: 1;
}

.ink-center {
  grid-column: 2;
  grid-row: 2;
  min-width: 0;
  /* Does not scroll itself: the editor manages its own scrolling internally.
     position:relative anchors the floating conflict bar and the right drawer. */
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--ink-bg);
}

.ink-statusbar {
  grid-column: 2;
  grid-row: 3;
}
```

- [ ] **Step 2b: Style the sidebar's internals**

Append to `shell.css`:

```css
.ink-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.ink-sidebar-switch {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  flex: none;
}

.ink-sidebar-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--ink-fg-muted);
  opacity: 0.6;
}

.ink-sidebar-tab:hover { opacity: 1; color: var(--ink-fg); }
.ink-sidebar-tab[aria-pressed="true"] { opacity: 1; color: var(--ink-link); }

.ink-sidebar-view {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
}

/* This hairline answers the status bar's top rule, which stops at the sidebar's right
   edge. Without it that rule reads as a truncation rather than a deliberate break. */
.ink-git-footer {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--ink-rule);
  color: var(--ink-fg-muted);
  font-size: 13px;
}

.ink-git-line { display: flex; align-items: center; gap: 6px; }
```

Delete the old `.ink-body` rule and the `.ink-git-actions` rule (its `margin-left: auto` and `padding-left` were for the status-bar layout that no longer exists). Keep `.ink-git-branch`, `.ink-git-branch-name`, `.ink-git-dirty-dot`, `.ink-commit-btn`, `.ink-push-btn`, `.ink-push-confirm`, and `.ink-git-error` unchanged. Add `.ink-statusbar { justify-content: flex-end; }` so the counts sit on the right.

- [ ] **Step 2c: Point the scrollbar rules at the new class**

In `src/web/theme/base.css`, the scrollbar rules target `.ink-left`. The scrolling element is now `.ink-sidebar-view`, so add it to each of the four selector lists alongside `.ink-left`.

- [ ] **Step 3: Simplify the editor padding**

In `src/web/editor/vditor-shell.css`, replace the `--ink-gutter` block with:

```css
/*
 * Content column width + writing margins.
 *
 * This element is the editor's scroll container (Vditor gives it height:100% + overflow),
 * so its right edge is where the scrollbar is painted — and it spans the full width of
 * .ink-center, putting that scrollbar against the window edge.
 *
 * All three need !important: in IR mode Vditor sets padding **inline** on .vditor-reset
 * (e.g. `padding:10px 170px`), and an inline style can only be overridden by an author
 * !important. Dropping it from padding silently restores Vditor's own value.
 *
 * The bottom 40vh lets the last line scroll to mid-viewport (Typora style).
 */
.ink-editor .vditor-ir .vditor-reset {
  max-width: none !important;
  margin: 0 !important;
  padding: 32px max(40px, calc((100% - var(--ink-content-width)) / 2 + 40px)) 40vh !important;
}
```

The drawer's width no longer needs reserving, because the drawer no longer holds the outline.

- [ ] **Step 4: Build and check by hand**

Run: `pnpm build`, then start a preview server against a scratch vault and confirm: the sidebar reaches the bottom of the window, the status bar starts at the sidebar's right edge, the git controls are in the sidebar footer, and the editor's scrollbar is at the window's right edge.

- [ ] **Step 5: Run the web project and typecheck**

Run: `pnpm vitest run --project web && pnpm typecheck`
Expected: green

- [ ] **Step 6: Commit**

```bash
git add src/web/layout src/web/editor/vditor-shell.css src/web/theme/base.css
git commit -m "feat(layout): sidebar spans full height, status bar scoped to the editor column"
```

---

### Task 8: End-to-end coverage and documentation

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `docs/design/layout.md`, `docs/design/editor.md`, `.claude/skills/inkstone/SKILL.md`
- Test: Playwright

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Add the e2e cases**

Append to `tests/e2e/smoke.spec.ts`:

```ts
// Jump and active tracking are pure geometry. jsdom reports every rect as zero, so a
// jsdom test of them would assert nothing while appearing to pass — they are e2e-only.
test('outline: lists headings, jumps to one, and tracks the active heading', async ({ page }) => {
  await login(page)
  await page.getByText('notes').click()
  await page.getByText('rich.md').click()
  await expect(page.locator('.vditor-ir h1')).toBeVisible({ timeout: 15_000 })

  await page.getByTitle('Outline').click()
  const rows = page.locator('.ink-outline-row')
  await expect(rows.first()).toBeVisible()

  const scrollTopBefore = await page.evaluate(
    () => document.querySelector('.vditor-ir .vditor-reset')!.scrollTop,
  )
  await rows.nth(1).click()
  await page.waitForTimeout(300)
  const scrollTopAfter = await page.evaluate(
    () => document.querySelector('.vditor-ir .vditor-reset')!.scrollTop,
  )
  expect(scrollTopAfter).not.toBe(scrollTopBefore)

  // After jumping to the second heading, that row becomes the active one.
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
})

test('sidebar: Cmd+1 / Cmd+2 switch views and Cmd+Alt+1 is left to the editor', async ({ page }) => {
  await login(page)
  await expect(page.locator('.ink-tree-container')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.locator('.ink-outline, .ink-outline-empty')).toBeVisible()
  await expect(page.locator('.ink-tree-container')).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.locator('.ink-tree-container')).toBeVisible()
})

test('layout: sidebar runs full height, status bar starts at its right edge', async ({ page }) => {
  await login(page)
  const geo = await page.evaluate(() => {
    const left = document.querySelector('.ink-left')!.getBoundingClientRect()
    const status = document.querySelector('.ink-statusbar')!.getBoundingClientRect()
    return {
      leftBottom: Math.round(left.bottom),
      leftRight: Math.round(left.right),
      statusLeft: Math.round(status.left),
      statusBottom: Math.round(status.bottom),
      viewportHeight: window.innerHeight,
      gitInSidebar: document.querySelector('.ink-left .ink-git-footer') !== null,
      gitInStatusBar: document.querySelector('.ink-statusbar .ink-git-footer') !== null,
    }
  })
  expect(geo.leftBottom).toBe(geo.viewportHeight)
  expect(geo.statusBottom).toBe(geo.viewportHeight)
  expect(geo.statusLeft).toBe(geo.leftRight)
  expect(geo.gitInSidebar).toBe(true)
  expect(geo.gitInStatusBar).toBe(false)
})
```

- [ ] **Step 2: Run the e2e suite**

Run: `pnpm test:e2e`
Expected: all green, including the pre-existing cases

Note: the existing `editor scrolls at the window edge…` test asserts `padRight === padLeft + drawerWidth`. That relationship no longer holds — the padding is now symmetric. Update that test to assert `padLeft === padRight` and that the scroller's right edge still equals the viewport width.

- [ ] **Step 3: Update the design docs**

In `docs/design/layout.md`: replace the "Where the reservation lives, and why" section with the simplified symmetric padding, and add a section describing the sidebar's two views, the switcher, the shortcuts, and the full-height span with the status bar scoped to the editor column. Record why switching beat stacking, and point at §7 of the spec for the stacked alternative.

In `docs/design/editor.md`: add the Vditor edit-mode hotkey guard to the gotchas, including why `options.keydown` cannot veto it.

In `.claude/skills/inkstone/SKILL.md`: add to the Vditor gotchas that `options.keydown` is called from inside Vditor's own listener and its return value is ignored, so blocking a Vditor hotkey requires a capture-phase listener on an ancestor; and that heading ids are derived from heading text and must not be used as identity.

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck && pnpm vitest run --project web && pnpm vitest run --project server && pnpm test:e2e`
Expected: all green

- [ ] **Step 5: Commit**

```bash
git add tests/e2e docs .claude
git commit -m "test(e2e): cover the outline panel, view shortcuts, and the new layout"
```

---

## Completion criteria

- [ ] `pnpm typecheck` reports no errors
- [ ] `pnpm vitest run --project web` and `--project server` are both green
- [ ] `pnpm test:e2e` is green
- [ ] The sidebar switches between the file tree and the outline, by button and by `Cmd/Ctrl+1` / `Cmd/Ctrl+2`
- [ ] The outline lists h1–h6, jumps on click, and highlights the heading currently being read
- [ ] The sidebar reaches the bottom of the window; the status bar covers only the editor column; the git controls are in the sidebar footer
- [ ] `Cmd/Ctrl+Alt+7/8/9` no longer switch the editor out of IR mode, and `Cmd/Ctrl+Alt+1`–`6` still set heading levels
- [ ] The repo still contains zero Chinese characters in tracked files
