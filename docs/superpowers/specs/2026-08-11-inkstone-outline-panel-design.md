# Inkstone Outline Panel and Sidebar Restructure — Design

The left sidebar becomes switchable between two views — the file tree and a document outline — and grows to the full height of the window. The status bar shrinks to sit only over the editor column, and the vault-level git controls move to the bottom of the sidebar.

This is the first slice of Phase 3. Phase 2 (the codex sidebar) is deferred; see the note in §8.

## Background and existing constraints

- The right panel is a floating drawer (`position: absolute`, 320px) that currently renders an empty `<div />`. `state/ui.ts` already has `rightTab = signal<'outline' | 'codex'>('outline')`.
- The editor's scroll container is `.vditor-ir .vditor-reset`. Vditor gives it `height: 100%` plus overflow, so `.vditor-content` never scrolls. Its `padding-right` currently reserves the drawer's width so the scrollbar can sit at the window edge (see `docs/design/layout.md`).
- `.ink-shell` is a three-row grid — top bar, body, status bar — so the status bar currently spans the full width.
- Panes are separated by a 1px `--ink-rule` hairline and all share `--ink-bg`; no pane is distinguished by fill.
- The chrome font is Maple Mono; the rendered document uses the Lapis faces. Colors live only in `tokens.css`, except the Lapis content theme, which is self-contained.
- Existing global shortcuts: `Cmd/Ctrl+\` toggles the left panel, `Cmd/Ctrl+/` toggles the right panel, `Cmd/Ctrl+S` saves.
- Testing: Vitest splits into `web` (jsdom) and `server` (node) projects and **must be run per project**. Playwright runs against a real build with `workers: 1`.

## Settled decisions

| Decision | Choice |
|---|---|
| Outline location | The left sidebar, not the right drawer |
| Sidebar form | **Switch** between file tree and outline; one visible at a time |
| Switching affordance | Two icon buttons at the top of the sidebar, plus `Cmd/Ctrl+1` and `Cmd/Ctrl+2` |
| Heading levels shown | h1–h6, all levels |
| Sidebar height | Spans the body and status rows, down to the bottom of the window |
| Status bar scope | The editor column only; holds the word and character counts |
| git controls | Move to the bottom of the sidebar (branch, dirty dot, commit, push) |
| Right drawer | No longer carries the outline; the code stays, unused |
| Stacked layout | Recorded as an alternative in §7, not implemented |

## 1. Why switch rather than stack

Both were prototyped at true 260px width. Stacking keeps the tree and the outline visible at once, which serves the outline's real value — glancing to see where you are, with no action at all. Switching costs an action but gives each view the full column: no truncated headings, no compressed tree.

The deciding factor was that a keyboard shortcut collapses most of switching's cost. With `Cmd+2` the outline is a keystroke away and hands are already on the keyboard while writing. What a shortcut cannot restore is passive visibility — but the prototype's long-document state showed stacking degrading exactly when the outline matters most: at 20 headings the outline hits its 40% cap and starts scrolling, the tree is squeezed to 60%, and third-level headings truncate. Trading the glance for both views being whole is the better deal here.

Because switching removes the width and height pressure, the outline lists **all six heading levels**. Under stacking the design limited it to h1–h3; that constraint no longer applies.

## 2. Reading the outline

IR mode renders headings as direct children of `.vditor-reset` — real `h1`–`h6` elements carrying `class="vditor-ir__node"` and a Vditor-generated `id`.

```ts
export interface OutlineItem {
  level: number        // 1-6, from the tag name
  text: string         // heading text with the ## marker stripped
  el: HTMLElement      // the live heading element
}

export function readOutline(root: HTMLElement): OutlineItem[]
```

`readOutline` walks `root`'s direct children, keeps those whose tag name matches `/^H[1-6]$/`, and for each one derives the level from the tag name and the text from `textContent` with the `.vditor-ir__marker--heading` span's content removed (that span holds the literal `## `, which is hidden visually but present in `textContent`).

**Do not key anything on the heading `id`.** Vditor derives it from the heading text, so editing a heading changes its id. Hold the element reference instead. Vditor's own `outlineRender` additionally rewrites these ids as a side effect, which is one of three reasons the built-in outline is not reused — the others being that it renders into its own `.vditor-outline` chrome (250px, its own border and panel fill, incompatible with the Lapis drawer) and that its scroll math targets `.vditor-ir` rather than our actual scroller.

`readOutline` is a pure function from a DOM element to an array, which is what makes the extraction directly unit-testable in jsdom.

## 3. Jumping and active tracking

**Jump.** Clicking an entry scrolls the editor's scroll container so the heading sits just below the top edge:

```ts
const delta = item.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
scroller.scrollTop += delta - 24
```

Rect deltas rather than `offsetTop`: `.vditor-reset` is `position: static`, so a heading's `offsetParent` is actually `.ink-center`, and `offsetTop` would be off by the top bar's height plus whatever padding intervenes. Rect deltas are independent of the positioning context.

**Active tracking.** A `scroll` listener on the scroller, throttled with `requestAnimationFrame`, marks the last heading whose `getBoundingClientRect().top` is at or above a threshold near the top of the viewport. The active entry takes the Lapis accent and semibold weight — no new color token.

**Recomputation.** The outline is derived from the `content` signal, and only while the outline view is the visible one. Vditor's `input` callback is already debounced by roughly 800ms, so no further debounce is needed. When the file tree is showing, nothing is computed.

## 4. Sidebar structure and switching

`state/ui.ts` gains:

```ts
export const sidebarView = signal<'files' | 'outline'>('files')
export function setSidebarView(view: 'files' | 'outline'): void
```

The sidebar becomes a flex column: a header row with the two switch buttons, the active view filling the remaining height, a hairline, then the git footer. Switching swaps only the middle region; the header and footer are stable.

Shortcuts are registered in App.tsx's existing global `keydown` handler, next to `Cmd+\` and `Cmd+/`:

| Key | Action |
|---|---|
| `Cmd/Ctrl+1` | Show the file tree (opening the sidebar if collapsed) |
| `Cmd/Ctrl+2` | Show the outline (opening the sidebar if collapsed) |

Plain `Cmd+digit` is free. Vditor hard-codes `Cmd/Ctrl+Alt+1..6` for heading levels and `Cmd/Ctrl+Alt+7/8/9` for edit-mode switching in `editorCommonEvent.ts`; both require `altKey`, so they do not collide. Vditor's 22 `Cmd+letter` toolbar hotkeys are inert in this app because hotkey lookup iterates `vditor.options.toolbar`, which we pass as `[]`.

## 5. Layout restructure

`.ink-shell` keeps its three rows but the sidebar now spans two of them:

```
grid-template-columns: var(--ink-left-width) 1fr
grid-template-rows: var(--ink-topbar-height) 1fr var(--ink-statusbar-height)

.ink-topbar    → grid-column: 1 / -1
.ink-left      → grid-column: 1; grid-row: 2 / 4    ← spans body + status rows
.ink-center    → grid-column: 2; grid-row: 2
.ink-statusbar → grid-column: 2; grid-row: 3
```

When the left panel is collapsed, the first column goes to `0` and the sidebar is not rendered, so the status bar spans the full width — the same as today.

The information split follows the structure: the status bar holds the word and character counts, which describe the **document**; the sidebar footer holds branch, dirty dot, commit, and push, which describe the **vault** — the same thing the sidebar itself shows.

One visual consequence needs handling. With every pane sharing `--ink-bg` and separated only by hairlines, a status bar that stops at the sidebar edge reads as an unfinished line unless something answers it. The sidebar's git footer therefore carries a top hairline of its own, so the two rules meet at the sidebar's right edge and read as one deliberate break rather than a truncation.

Since the drawer no longer holds the outline, `.ink-center` and the editor's padding formula revert to the simple form:

```css
.ink-editor .vditor-ir .vditor-reset {
  max-width: none !important;
  margin: 0 !important;
  padding: 32px max(40px, calc((100% - var(--ink-content-width)) / 2 + 40px)) 40vh !important;
}
```

All three still need `!important`: Vditor sets `padding` **inline** on `.vditor-reset` in IR mode, and an inline style can only be overridden by an author `!important`. Dropping it from `padding` in particular would silently restore Vditor's own `10px 170px`.

The scroll container still spans the full width, so the scrollbar stays at the window edge; there is simply no drawer width to reserve on the right any more. The drawer's own CSS and the `rightPanelOpen` signal stay in place, unused, for whatever Phase 2 turns out to need.

## 6. Guarding Vditor's edit-mode hotkeys

`Cmd/Ctrl+Alt+7/8/9` switch Vditor between `wysiwyg`, `ir`, and `sv` modes. This app only supports IR: the Lapis theme and every shell rule are scoped to `.vditor-ir`, and there is no UI to switch back. Pressing `Cmd+Alt+7` today leaves a visually broken editor with no recovery short of reloading.

The `keydown` option runs before Vditor's internal handling, so the guard lives there: swallow the event when Ctrl/Cmd and Alt are held with `Digit7`/`Digit8`/`Digit9`, and leave `Digit1`–`Digit6` alone so heading shortcuts keep working.

## 7. Alternative: the stacked sidebar

Recorded so it can be adopted later without re-deriving it. Not implemented.

The sidebar shows both views at once, stacked vertically: the tree fills the available height, a hairline separates them, and the outline sits below with its height following its content and capped:

```css
.ink-tree-pane    { flex: 1 1 auto; overflow: auto; }
.ink-outline-pane { flex: 0 1 auto; max-height: 40%; overflow: auto; }
```

`height: auto` up to a 40% cap is what makes this work: a note with five headings gives the outline five rows and the tree keeps the rest, and only a long document pushes the outline to its cap and starts it scrolling.

**Trade-off.** Both views are visible with no interaction at all, which is what the outline is really for. The cost appears exactly when the document is long: two scroll regions share 260px of width, the tree is compressed to 60% of the height, and deeper headings truncate. Under this layout the outline should list only h1–h3 and rely on ellipsis plus a `title` attribute for the full text.

**What would change to switch to it.** The sidebar's flex structure and its CSS; `sidebarView` becomes unnecessary or is repurposed to a focus target; the two shortcuts move focus rather than swapping views. `readOutline`, the jump, the active tracking, and the layout restructure in §5 are all unaffected. Keeping the outline list rendering in its own component with no knowledge of the sidebar's arrangement is what keeps this a small change.

## 8. Deferred: the codex panel

Phase 2 is on hold. The likely direction is a per-user local binary communicating with the server, rather than the server spawning `codex exec` subprocesses — which changes the security model enough that the original §5 of `2026-08-09-inkstone-design.md` should be re-derived rather than followed. The right drawer stays in the codebase for it.

## 9. Error handling and edge cases

| Scenario | Handling |
|---|---|
| No file open | The outline view shows the same muted empty-state line style as the file tree |
| Document has no headings | An empty-state line, not a blank pane |
| Heading text is empty (`##` with nothing after) | Listed with its level, showing a muted placeholder, so the row is still clickable |
| A heading is deleted while its entry is being clicked | The element is detached, so `getBoundingClientRect()` returns zeros; skip the jump rather than scrolling to the top |
| Editor not yet mounted | `readOutline` returns an empty array when handed a null or empty root; nothing special-cased at the call site |
| Sidebar collapsed when a shortcut fires | Open the sidebar, then set the view |
| Sidebar collapsed while git controls live in its footer | The footer unmounts with the sidebar, so `GitFooter` renders in the status bar instead — one instance either way |

## 10. Testing

| Target | Method |
|---|---|
| `readOutline` | Vitest (jsdom): levels from tag names, `## ` marker stripped, non-heading children skipped, empty document, empty heading text |
| `sidebarView` + `setSidebarView` | Vitest: the signal changes, and setting a view opens a collapsed sidebar |
| Shortcut handling | Vitest on the handler: `Cmd+1`/`Cmd+2` select views; `Cmd+Alt+1` is not intercepted |
| Edit-mode guard | Vitest on the `keydown` option: `Cmd+Alt+7/8/9` are swallowed, `Cmd+Alt+1`–`6` pass through |
| Jump and active tracking | Playwright — both need real layout, which jsdom does not provide |
| Layout restructure | Playwright: the sidebar's bottom edge reaches the window bottom; the status bar's left edge starts at the sidebar's right edge; the git controls are inside the sidebar |

Jump and active tracking are deliberately e2e-only. They are pure geometry, and jsdom reports every rect as zero, so a jsdom test of them would assert nothing while appearing to pass.

## 11. Explicitly out of scope

Global search and HTML export (the rest of Phase 3); a draggable sidebar width; collapsible outline sections; a setting to choose between the switch and stacked layouts; restoring the last-used view across reloads.
