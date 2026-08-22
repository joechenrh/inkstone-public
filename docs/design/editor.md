# Editor

The editor is Vditor in **IR mode** (instant rendering), the mode that behaves like Typora: markdown is rendered in place, and the source markers appear only around the caret. It replaced a CodeMirror + preview-pane setup in Phase 1, because keeping a separate preview pane in sync is exactly the experience Typora exists to avoid.

All of it lives in `src/web/editor/VditorEditor.tsx` plus three stylesheets: `vditor-shell.css` (neutralize Vditor's chrome), `lapis-theme.css` (the content theme), `fonts.css` (self-hosted faces).

## Self-hosting the assets

`scripts/prepare-assets.mjs` copies `node_modules/vditor/dist` to `public/vditor/dist`, and the editor is configured with `cdn: '/vditor'`.

The `dist/` segment is not cosmetic. Vditor hardcodes every runtime asset URL as `` `${cdn}/dist/...` `` — verified for i18n bundles, the lute engine, content themes, icons, emoji, and mathjax. Copying the *contents* of `dist` into `public/vditor` (dropping the segment) produces 404s like `/vditor/dist/js/i18n/zh_CN.js` at runtime, which the build never catches. `tests/server/prepare-assets.test.ts` asserts the layout, and the e2e no-external-request test catches any asset that falls back to the public CDN.

## Neutralizing Vditor's chrome

Vditor ships a full editor UI; Inkstone wants a bare page.

- `toolbar: []` still renders a 1px bordered empty toolbar bar. It is hidden in CSS.
- The host element receives the `vditor` class itself, so the shell selector is the compound `.ink-editor.vditor` — its border is stripped there.
- `.vditor-ir pre.vditor-reset:focus` sets a background colour at specificity 0,3,1. Fighting that with a more specific selector is fragile; instead `vditor-shell.css` overrides the *variables* it reads (`--panel-background-color`, `--textarea-background-color`) so focus and blur resolve to the same colour.
- Vditor sets an **inline** `padding: 10px 170px` on `.vditor-reset` in IR mode. Inline styles beat any author selector, so the content-column rule is one of the few places in the codebase using `!important`:

```css
.ink-editor .vditor-ir .vditor-reset {
  max-width: none !important;
  margin: 0 !important;
  padding: 32px max(40px, calc((100% - var(--ink-content-width)) / 2 + 40px)) 40vh !important;
}
```

The scroll container spans the full width so its scrollbar lands at the window edge, and the padding centres the column inside it — see [layout.md](layout.md). The `40vh` bottom padding is deliberate: it lets the last line scroll to the middle of the viewport instead of sitting against the bottom edge.

- `cache: { enable: false }` — Vditor's own localStorage cache would compete with our draft persistence and could resurrect content for the wrong file.
- `lang: 'en_US'` — Vditor defaults to `zh_CN`. Left unset, it fetches the Chinese i18n bundle and renders all of its own UI text (hints, tooltips, the code-block language input, upload messages) in Chinese, which no amount of grepping the repo's own source will reveal.

## Sync between the editor and `content`

Two directions have to coexist without fighting:

1. **User types** → Vditor's `input` callback → `editContent(value)`.
2. **Something external changes `content`** (opening a file, external reload, "take disk version") → push into the editor with `setValue`.

Three refs make this safe.

`readyRef` — set in `after()`. Nothing touches the instance before Vditor finishes initializing.

`settingRef` — set around every `setValue` so the resulting `input` does not feed back as a user edit. It **must** be reset in a `finally`; if `setValue` throws while the guard is set, every subsequent keystroke is silently discarded.

`lastSyncedRef` — the value on which the editor and `content` already agree. It does two jobs:

- **Filters the async echo.** `setValue` dispatches an `input` asynchronously, after `settingRef` has already been reset synchronously. Without a value comparison against `lastSyncedRef`, merely opening a file would mark the document dirty.
- **Decides push-back.** The push-back effect compares `content` against `lastSyncedRef`, **not** against `vd.getValue()`. During fast typing `getValue()` runs ahead of `content`; comparing against it misjudges the situation and `setValue`s an older value back into the editor, swallowing what was just typed. `lastSyncedRef` only differs from `content` when something genuinely external changed it.

`setValue(next, true)` passes `clearStack` on push-back so undo cannot walk back across a file switch.

## The ~800ms input debounce

Vditor debounces the IR `input` callback by roughly 800ms. Typing and immediately pressing Ctrl+S therefore saves stale content — or nothing at all. This was a real data-loss bug, caught by e2e.

The fix is in the `keydown` option: on Ctrl+S, synchronously read `vd.getValue()`, and if it differs from `content`, align `lastSyncedRef` and call `editContent` before the save runs. The handler deliberately does **not** save. The event keeps bubbling to the global keydown handler in `App.tsx`, which owns `flushSave` plus the git-status refresh. One keypress, one save path — an earlier version saved in both places and the two concurrent requests carried the same stale `baseMtimeMs`, producing a false "file changed on disk" on every single save.

## Fenced code and math blocks

IR mode renders **two** `<pre>` for every fenced block: `pre.vditor-ir__marker--pre` holding the raw source, and `pre.vditor-ir__preview` holding the highlighted render. Vditor keeps the source collapsed to a `0x0` `overflow: hidden` box until the caret enters the block, and shows both stacked once it does.

Two consequences shape `lapis-theme.css`:

- **Never style a bare `pre`.** The selector hits the collapsed source too, and its padding and background then paint outside the zero-size box as a stray coloured sliver next to the ``` fence. Style `pre.vditor-ir__preview` and the expanded source explicitly, and reset the collapsed source to transparent with no padding.
- **Hide the render while editing.** Vditor's stacked source-plus-render reads as a duplicated block. `.vditor-ir__node--expand > pre.vditor-ir__preview { display: none }` gives the Typora behaviour: source while the caret is inside, render once it leaves. The expanded source also needs `display: block` — Vditor's expand rule sets `display: inline` on all markers, and an inline `<pre>` paints its background as a ragged band across the lines.

- **A math block reserves its render's height.** Hiding the render is right for code, where source and render are the same text over the same number of lines, and wrong for math, where one line of LaTeX replaces a rendered display formula — measured 58px against 88px, so entering the block pulled the rest of the document up 30px and leaving it dropped it back. The expanded math node is a one-cell grid holding both `<pre>`, so its height is the taller of the two: the render is `visibility: hidden` rather than `display: none`, which reserves its box while taking no clicks, and a formula whose source runs longer than its render still grows the node. The override beats the `display: none` rule above on specificity, (0,6,1) against (0,5,1), rather than with `!important`.

Inline-code rules must be scoped with `:not(pre) >`. Unscoped, `.vditor-reset code:not(.hljs)` outranks `.vditor-reset pre code` on specificity and applies inline-code padding and background to the block's source.

The `<code>` inside a block needs its own background and padding cleared, and doing so requires beating **two** rules: Vditor's `.vditor-reset code:not(.hljs):not(.highlight-chroma)` at (0,3,1), and the identical selector in the content theme, which is injected into `<head>` at runtime by `setTheme` and therefore wins ties against the bundled stylesheet. Prefixing `.ink-editor` reaches (0,3,2) and beats both.

## Editing tables

Vditor implements every table operation, and before this phase none of them was reachable. It binds them to keys a browser keeps for itself — `⌘=` and `⌘-` are zoom, `⇧⌘C` is devtools — two of its bindings (`⇧⌘=`, `⇧⌘-`) never match its own hotkey test at all, `setTableAlign` writes `style.textAlign` rather than the `align` attribute the markdown is serialised from, and Tab walked out of the table instead of to the next cell.

**The controls are ours; the edits are made against the rendered table.** `tableOps.ts` rewrites the DOM and then dispatches `input` on the editable surface, which is what makes Vditor re-serialise through lute and hand the markdown to the editor's own input callback — verified end to end, from a row added by a button to that row present in the file on disk. Vditor's own functions are module internals and unreachable from an instance; rewriting the markdown instead would mean `setValue`, which rebuilds the document and drops the caret.

**Vditor replaces the table element when it re-serialises, synchronously.** Any reference taken before an edit is detached when it returns — the toolbar's `table` prop included, and any caret placed before it is gone. `applyTableEdit` in `VditorEditor.tsx` is the single place that knows this: it finds the table again by its position among the document's tables, and restores the caret by row and column index rather than by node. Nothing else should dispatch a table change.

The bar is an overlay in editor coordinates inside `.ink-editor-stack`, never a child of the editable surface — anything put there becomes part of the document and is written to the file. It sits in a **26px band reserved above every table**, occupied or not, so a control appearing never moves the document. Its width comes from the *rows*, not the `<table>` box: several themes set `display: block` so a wide table can scroll, which leaves the box filling the column while the rows shrink to their content (measured 458px against 201px in Lapis), and the delete button ended up far to the right of anything visible.

| | |
|---|---|
| Bar | Size grid, three column alignments showing the current column's state, delete table |
| Right-click | Insert and delete row/column **at that position**, which the size grid cannot express — it only grows and shrinks from the end |
| `Tab` / `⇧Tab` | Next / previous cell, wrapping across rows; at the end it adds a row |
| `⏎` in the last cell | Adds a row. Everywhere else Enter is Vditor's, and is the only keyboard way out of a table |
| `⇧⌘F` / `⇧⌘G` | Insert row above / column left. Vditor's own bindings, intercepted and routed through our operations — its inserted cells carry no `align`, so adding a row to an aligned column silently dropped the alignment on that row |

A markdown table cannot lose its header row or its last column, so both are disabled in the menu rather than left to fail.

Round-trip note, pre-existing and not caused by this: a document containing a table is reformatted by lute on the first save after any edit — cells padded, delimiter row rewritten, one blank line added before the table. Measured as **idempotent**: three further edit-and-save cycles produce no further change.

## Source mode

`Cmd/Ctrl+Alt+M` swaps the rendered document for its raw markdown, for the edits the renderer is in the way of. Rendered **over** the editor column, like the empty state, so VditorEditor stays mounted.

It is a plain `<textarea>` with a gutter, deliberately. Selection, undo, IME composition, find-in-page and the accessibility affordances are the browser's to get right, and this is the one view whose purpose is being trusted with the exact bytes. The alternative that looked free — a highlighted layer behind a transparent textarea, using the highlight.js Vditor already loads — needs two elements to wrap and measure identically forever; the gutter alone demonstrated the failure, drifting to 346px of text against 273px of gutter until wrapping was turned off. **The textarea does not wrap**: one logical line is one row, which is what makes a line number mean anything, at the cost of a horizontal scrollbar on long prose lines.

**Nothing is pushed through the renderer while source mode is open.** The effect that syncs `content` into Vditor returns early, and runs once when the mode closes. Two reasons, both the point of the mode:

- An intermediate state that is not yet valid markdown would otherwise be re-rendered under the caret on every keystroke.
- A round trip through lute reformats the whole document — table cells padded, delimiter row rewritten, a blank line added above the table. That already happens on any edit to the rendered view and is idempotent, but it must not happen to text typed *as source*. Verified end to end: a file whose only edit was made here saves byte-exact, tight table and all, and survives a trip out to the rendered view and back.

Read-only applies here too: the text is shown and the textarea is `readonly`.

## Opening a file blocks the main thread

Profiled while opening a 108K-character note: **`diff_bisect_` alone took 211ms** of a 406ms block. That is Google's diff-match-patch, run by Vditor's undo stack.

`setValue(markdown, clearStack)` renders, then calls `processAfterRender({ enableAddUndoStack: true })`, which diffs the **whole outgoing document against the whole incoming one** — and only *then*, at the end, clears the stack and throws the result away. Every file switch paid for a full-document diff whose output was discarded.

Clearing first (`vd.clearStack()` then `vd.setValue(next)`) leaves `lastText` empty, so the same diff has nothing to compare against. Measured as medians of five runs, switching from a small note:

| Note | `setValue(next, true)` | `clearStack()` then `setValue(next)` |
|---|---|---|
| 60K chars, prose | 0ms | 73ms |
| 30K chars, code blocks | 0ms | 101ms |
| 109K chars, mixed | **431ms**, ranging 77–480 | **179ms**, stable |

**This is a trade, not a clean win.** The large-document freeze — the one that is actually visible as a stall on a click — more than halves and stops fluctuating, while medium documents go from free to roughly 80ms. Everything now sits under the ~100ms mark where a response still reads as immediate, where before the worst case was four times over it. Individual readings vary by 2x, so any future comparison here needs medians of several runs, not one measurement.

What was **not** done: the remaining cost is Vditor rendering the document and highlight.js colouring it, which is inherent to replacing the whole document on every open. Avoiding it means not calling `setValue` for a file switch at all, which is a larger change.

## Blocking Vditor's edit-mode hotkeys

Vditor hard-codes `Ctrl/Cmd+Alt+7/8/9` to switch between its `wysiwyg`, `ir`, and `sv` modes. This app is IR-only — the Lapis theme and every shell rule are scoped to `.vditor-ir`, and there is no UI to switch back — so one stray press leaves a visually broken editor with no recovery short of a reload.

The `keydown` option cannot stop it. Vditor calls `options.keydown(event)` from *inside* its own `keydown` listener on `.vditor-ir`, ignores the return value, and never checks `defaultPrevented`, so neither returning nor `preventDefault` nor `stopPropagation` from the option has any effect. The guard is instead a **capture-phase listener on the host element**, an ancestor of `.vditor-ir`: capture runs strictly earlier, and `stopPropagation` there keeps the event from ever reaching Vditor. `Digit1`–`Digit6` are deliberately left alone so heading shortcuts keep working.

## Read-only when nothing is open

`syncEditable` calls `vd.enable()` / `vd.disabled()` from `currentPath`. Without it the empty editor accepts typing that has nowhere to go.

## Theme handoff

`vd.setTheme(resolvedTheme === 'dark' ? 'dark' : 'classic', 'light')` runs in `after()` and again whenever `resolvedTheme` changes. The content theme argument stays `'light'` in both modes: our bundled dark rules are scoped under `:root[data-theme="dark"]` and override it, so no second content-theme file has to be shipped. Passing a content-theme name with no matching file on disk would 404.

## Links between notes

A link may point at another note or at a heading, and following it opens that note here rather than handing a path to the browser. **Resolution is GitHub's**, because these notes are read on github.com as well: no leading slash resolves against the note's own directory, a leading slash against the vault root.

| Written | From `notes/deep/a.md` | |
|---|---|---|
| `#some-heading` | this note | scrolls, GitHub's slug rules |
| `b.md`, `./b.md` | `notes/deep/b.md` | opens |
| `../c.md`, `/notes/c.md` | `notes/c.md` | opens |
| `b.md#heading` | `notes/deep/b.md` | opens, then scrolls |
| `/assets/…` | — | new tab, through `assetUrl` |
| `https:`, `mailto:` | — | new tab |
| anything else | — | nothing at all |

`editor/note-links.ts` holds all of it and neither engine knows any of it — the rule the pictures established. Percent-decoding happens first (`%E6%B5%8B%E8%AF%95.md` → `测试.md`), and a path that climbs out of the vault is refused rather than clamped.

**The gesture is one gesture**: `Cmd/Ctrl+click` while editing, a plain click while reading. It was not, before: Crepe required a modifier and refused everything but `https:`/`mailto:` silently, while Vditor followed a *plain* click by handing the relative path to `window.open` — so the browser left the page for `/notes/other.md` and the SPA fallback returned `index.html`, which looks like the application reloading itself. Vditor now runs with `link: { isOpen: false }` and a capture-phase listener of ours.

Anchors are matched on slugs computed from the rendered heading text via `blockText()`, never on the DOM `id`: Vditor derives those from the text and rewrites them on every edit, which is the same reason the outline holds element references.

**Getting back** is `Cmd/Ctrl+[` and `]`, over an in-memory visit stack (`state/visits.ts`). Not `history.pushState` — the browser's Back belongs to the routes this application really has, and spending it here would make it mean two things depending on how you arrived. A dead end is a bug, and following a link was one.

**On a shared page an internal link is not a link.** A share is a copy of one file; the note it points at was never published and the reader has no account for it, so the words stay and the href goes.

## Alerts

GitHub's five callouts — `> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION` — uppercase, the blockquote's first line, never nested. Somebody else's extension, implemented rather than invented because these notes are read on github.com, where it already renders, and in Typora, which renders it too.

**It is a rendering feature with no storage risk.** The syntax is ordinary CommonMark — a blockquote with an unremarkable first line — and both engines were measured round-tripping one byte for byte before any of it was written. An editor that failed to draw it would show a quote with `[!NOTE]` in it, which is what every other markdown tool shows.

`editor/alerts.ts` holds the rule and nothing else: the five names, uppercase only, the marker as the whole of the first line. `alerts.css` holds every colour, the tint, the icons and the label, keyed on `.ink-doc` — never on an engine's class, which is the fortnight's lesson about document facts.

**The marker is collapsed, not removed.** It is text that is really there, so it comes back the moment the caret enters the blockquote — the rule this editor already follows for bold, inline code, headings, links and pictures. The icon and the rule do not move, so only the first line changes.

The two engines attach it differently, and that difference is the whole of the engine-specific code:

| Surface | How | Why not the other way |
|---|---|---|
| Vditor, the reader page | `alert-dom.ts` — a `MutationObserver` tags the blockquote and wraps the marker in a span | Measured safe: Lute serialises a plain span as the text inside it, so the wrap does not reach the file |
| Crepe | `alert-reveal.ts` — node and inline decorations | ProseMirror reads unexpected DOM changes back as edits; a stylist reaching into it can rewrite the document |

Three things cost more than they look:

- **Crepe draws its own quote bar as `blockquote::before`, 4px wide.** It tied with the icon rule on specificity and won on source order, so the mask was correct and painted into a 4px sliver. The icon's box is `!important`, for the reason `document-column.css` is.
- **A ProseMirror inline decoration applies to each inline node in its range**, so the marker and the break after it arrive as two adjacent spans — the label was drawn twice, and the second span kept 6px of line, which is where the two engines stopped agreeing on the height of a callout.
- **The marker span has to be a block.** As an inline it still opened a line box of its own, and the body sat a whole line lower: 97px of callout where 65 was the arithmetic.
- **The label and the syntax are one slot**, so they take one face, one size and one leading — the syntax is the label with different glyphs and a colour, which is what Typora does and what `marker-reveal.ts` already did. Reaching for monospace and `font-size: inherit` made a callout resize every time a caret entered one; so did leaving the label's 2px margin on the pseudo-element, which left with it. All four states — two engines, caret in and out — now measure 68px, and an e2e test compares them exactly rather than approximately.

## Line breaks, and the one engine that cannot make one

Measured at the source: `lute.VditorIRDOM2Md('<p>A<br>B</p>')` returns `"A\nB"` — a **soft** break. Vditor's markdown engine has no representation for a hard break on the way out, and it re-serialises a block on every keystroke, so a break cannot be written there and one already in a note does not survive being typed near.

Three ways round it were tried and measured, and all of them hold only until the next character: inserting a `<br>` (Lute reads it as soft), inserting the markdown `\` + newline through `insertValue` (survives the first render, not the second), and putting the `\` back around every read (fixes the *save* but not the engine's own re-render). Patching Lute's methods on the instance had no effect.

So there is no Shift+Enter in that engine. A keystroke that silently produces something the engine will destroy is worse than no keystroke, and Crepe has had one all along — `tests/e2e/breaks.spec.ts` holds it there.
