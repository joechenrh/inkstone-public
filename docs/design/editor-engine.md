# The editor engine

Vditor has been the editor since Phase 1. This records what it costs, what the alternatives cost, and what was measured rather than assumed. The numbers below came out of a harness that mounted each engine the same way and drove all three with one script; it was deleted with the decision, which is what it was for. They were taken on a real note — 27 KB, 41 headings, 41 code fences, tables, CJK throughout — and on that same note four times over, 109 KB, which is where the engines separate.

## Why this came up

A week of use produced seven complaints, and four of them were the same complaint: undo emptied a freshly opened document, a code block could not be deleted without switching to source mode, the table toolbar lagged, the outline was a second behind the caret. Each was fixed. Each fix was a workaround for the same thing.

**Vditor has no document model.** Its markdown is reconstructed from the DOM by lute, a Go library compiled to wasm. There is no `doc` to operate on, so every operation is a question about the DOM: which `<pre>` did the caret escape, is `(P, 0)` the same place as `(#text, 0)`, which of the four `.vditor-reset` elements is the real one. The answers are knowable and we have written them down, but each one is a fact about a library's internals rather than about markdown.

In a ProseMirror-based editor, deleting a node is `tr.delete(from, to)`, undo is a model-level history, and markdown is a serialiser. That whole class of question does not exist.

## What was measured

| | Vditor | Crepe (Milkdown) | CodeMirror 6 |
|---|---|---|---|
| **Round trip** | the DOM *is* the source | **rewrites 59 lines** on open→read, then idempotent | **byte-identical** |
| Open 109 KB | 355 ms | 401 ms | **98 ms** |
| Typing, 109 KB | **41.7 ms** median, 47.2 p90 | 16.6 / 16.9 | 16.4 / 17.8 |
| Typing, 27 KB | 16.7 ms | 16.6 | 16.7 |
| Undo an edit | needed fixing | ✓ | ✓ |
| Undo on a freshly opened file | **emptied the document** | ✓ no-op | ✓ no-op |
| Delete a code block from outside it | **two custom capture handlers** | works unaided | it is a text range |
| Read the headings | 0.11 ms (DOM scan) | 1.1 ms | 1.5 ms (from the source) |
| Typora-like out of the box | ✓ | ✓ | **✗** |

Three things in that table decide it.

**Typing at 109 KB.** Vditor is 2.5× slower per keystroke, and both alternatives sit at the frame floor — 16.6 ms is one frame at 60 Hz, which is the measurement's own floor rather than a cost it can see. This is the "it gets sluggish" report, and it is not inherent: 96% of Vditor's per-keystroke cost is lute re-serialising the whole document. Our own listeners are 1.3 ms of it.

**Undo and deletion.** Both alternatives do unaided what Vditor needed custom interception for. That is the bug class, gone rather than papered over.

**Round-trip fidelity.** This is the one that matters most for an application whose truth is a `.md` file in somebody's git repository, and it is the one where Crepe is weakest. (Re-measured later, it is the one where Crepe is *strongest*; see the last section.)

## The round trip

Opening the note in Crepe and reading it straight back changes 59 lines. Nothing is lost — table columns are re-padded, `-` bullets become `*` — but the file is rewritten. For a git-backed editor that means opening a note and saving it produces a diff full of lines nobody edited.

**It is idempotent**, which changes the cost from ongoing churn to a single event: reformat once, and it stays put. That is what Prettier does to a codebase, and it is survivable if it is done deliberately — a normalise pass the reader asks for — rather than discovered in a commit.

CodeMirror is byte-identical, and cannot be otherwise: the model is the text, so there is nothing to round-trip through.

## The catch in CodeMirror

`basicSetup` plus the markdown language is a **source view with line numbers**. It is not Typora-like and does not pretend to be. Obsidian's live preview is built on CodeMirror 6, and that is the point: they built it. Hiding markers when the caret leaves the line, rendering tables and images inline, keeping the two in agreement — that is months of decoration work, not an afternoon.

So the choice is not "Crepe or CodeMirror". It is:

- **Crepe** — the editing experience arrives, and a one-time reformat arrives with it.
- **CodeMirror** — perfect fidelity and the fastest open, and you write the live-preview layer.
- **Vditor** — neither cost, and the bug class stays.

## What it would take

`src/web/editor/` is **933 lines** of code and about 1,100 CSS references scoped under Vditor's classes. The code is rewritten. The CSS is re-scoped, not redesigned: the seven document themes are colour, type scale and spacing decisions that survive a change of class names.

Nothing else moves. The GitHub backend, sharing, the agent, history, the file tree, the commit panel and authentication do not know which editor is mounted.

## Judged on rendering and editing

Those were the criteria, so the metrics above only get a vote where they change one of them.

### Rendering: a tie, and Vditor's lead is ours rather than its

Both render the real note well — tables, fenced code with highlighting, lists, quotes, CJK. Vditor looks better *today* for one reason: seven document themes were written for it. Crepe's own theme is clean and modern, and matching Lapis is the same work again — **re-scoping, not redesigning**, since the themes are colour, type scale and spacing.

One difference is Crepe's and it is not cosmetic: a fenced block is a real **CodeMirror instance with a language picker**, so editing code is editing code. The note this was measured on has 41 fences.

### Editing: Crepe wins everything except one thing

| | Vditor | Crepe |
|---|---|---|
| Undo | emptied a fresh document until fixed | works |
| Delete a code block | two custom capture handlers | works unaided |
| Typing, long note | 41.7 ms | 16.6 ms |
| Inside a fence | the raw source expands | a code editor with a language picker |
| **Markdown syntax revealed at the caret** | **yes — `##` goes 0 → 24 px on entry** | **never shown** (no longer true; see the last section) |

The last row is the one real loss, and it is the Typora signature: put the caret in a heading and the `##` appears, editable in place.

**It is survivable because the application already answers that need another way.** `Cmd/Ctrl+Alt+M` is a source mode that shows the file exactly as it is on disk. Seeing and editing raw markdown is a mode, not a thing only the caret can reach.

### The reformat, checked against awkward markdown

A file of deliberately hostile constructs — raw HTML blocks, `<kbd>`, footnotes, task lists, a table with three alignments, a setext heading, hard line breaks, autolinks, strikethrough — came back with **13 lines changed and nothing lost**. Every change was a normalisation with identical meaning:

- `-` bullets → `*`
- table alignment re-padded, all three markers intact
- setext `===` → `# `
- two trailing spaces → `\`

Raw HTML, footnotes, task lists and autolinks round-tripped untouched. So the cost is a formatting normalisation, once per note, and not a loss.

### Weight, where the obvious measurement is the wrong one

Bundled, Crepe looks alarming: **2,844 kB of JavaScript against Vditor's 480**. That number is
misleading and it took a second measurement to see why — **Vditor loads lute and its runtime assets
over the wire rather than through the bundle**, so a bundle comparison counts one and not the other.

What a reader actually downloads to open a note, each engine built alone:

| | over the wire | of which JS | of which fonts |
|---|---|---|---|
| Vditor | 7.81 MB | 5,409 kB | 2,322 kB |
| Crepe | **5.69 MB** | 5,480 kB | 16 kB |

The JavaScript is within 1.3% of each other. The font gap is not an engine property at all — Lapis
pulls Source Han Serif CN for CJK, and Crepe is not wearing Lapis yet, so that 2.3 MB reappears the
moment it is themed.

**So weight is not an argument either way**, which is worth recording precisely because the first
number said loudly that it was.

## Decision: move to Crepe

By the stated criteria — rendering and editing — it wins editing outright and draws on rendering. The bug class that produced four of the last seven complaints is structural in Vditor and absent in a model-based editor, and the one capability lost is already served by source mode.

The reformat is done **deliberately**: a normalise pass that is its own commit, per note, so it is never discovered in a diff.

CodeMirror 6 is not chosen, and the reason is the criterion rather than its quality: out of the box it is a source view with line numbers. Obsidian's live preview is built on it — built being the point. That is months of decoration work, and the criterion was the editing experience, not the foundation.

## What changed since, measured again

The decision above was taken with two costs attached. Both were re-measured after the Crepe engine
had been worked on for a while, by rendering one deliberately hostile note and one real document in
each engine and reading the files back. Neither cost survived.

### The one capability that was lost is back

"Markdown syntax revealed at the caret — Vditor yes, Crepe never shown" was the one row Vditor won
outright. Crepe now shows the syntax of the run the caret is in, as **real text** rather than as
decorations, which is what `source-reveal.ts` already did for links: the marks become `` `a` `` or
`**bold**` while the caret is in them and go back to being code or bold when it leaves. Widgets
were tried first and could not be made to work — a document position maps to one DOM point, so
"inside the closing backtick" and "after it" are one caret that cannot be drawn twice, a click
carries no side, and Backspace cannot reach a marker that is not in the document. Headings keep
their `#`s in the gutter, which is a decoration because nothing is ever typed beside them.

### Round-trip fidelity is now Crepe's, not Vditor's

The table said "the DOM *is* the source" for Vditor and "rewrites 59 lines" for Crepe. On a note of
hostile constructs, opening and saving:

| | Vditor | Crepe |
|---|---|---|
| Lines changed | 15 | 12 |
| A hard break (two trailing spaces) | **dropped** | written as `\` |
| A footnote definition | **moved to the end of the file** | left where it was |
| `- [x]` | rewritten `- [X]` | untouched |
| A bare URL | untouched | written `<…>` |

Every one of Crepe's changes preserves meaning. Two of Vditor's do not.

On a real 120-line, table-dense document the churn was 47 lines for Vditor and 58 for Crepe — until
two settings closed most of it. `bullet: '-'` stops `-` bullets becoming `*`, and the gfm plugin's
`tablePipeAlign: false` stops a hand-written `| a | b |` being padded into a grid. **Crepe's churn
on that document is now 6 lines**, all of them the delimiter row's spelling (`|---|` written as
`| - |`), for which there is no option. Vditor's is unchanged.

### What Crepe still does not do

Re-measured feature by feature against the same note. Task lists, tables and their alignments,
alerts, inline and block maths, images, hard breaks, the outline, source mode, search, note links
and heading anchors are all a tie. Footnotes and bare URLs are Crepe's. Definition lists are
neither's. What was left, and what was then done about it:

| | Then | Now |
|---|---|---|
| Mermaid and the other diagram languages | Vditor drew them, Crepe showed the source | Mermaid draws, through the same preview panel the formula block uses. The rest of Vditor's diagram languages — graphviz, plantuml, echarts, abc — are still Vditor's alone |
| `:smile:` | Vditor rendered it | Typed, it becomes the emoji; one already in a file is left alone, because rendering it would write the emoji into the note on the next save |
| The caret's place when the source opens | Neither kept it | Kept, by block, in both directions |

On a phone, the Crepe suite passes eleven of the phone suite's twelve tests and the twelfth is the
suite's own timing: it measures the document's width during the screen transition, where Crepe is
visible a frame earlier than Vditor. Given a moment to settle, both measure the same 358 px.

**Not measured, and so not claimed**: a real touchscreen (Playwright's emulation is not iOS
Safari), IME composition, pasting rich HTML from a web page, printing.

## Vditor is gone

Retired once the last of the gaps above was closed. What went with it:

| | |
|---|---|
| `VditorEditor.tsx`, `vditor-shell.css` | 1,142 lines |
| The engine setting, its storage key, the Settings row | — |
| The `vditor` dependency and `public/vditor` | **23 MB** of runtime assets, and `scripts/prepare-assets.mjs` with them |
| Dead selectors in the seven themes | 19 rules, 42 selector lists trimmed |
| Vditor-only specs | `tables.spec.ts`, `editor-switch.spec.ts`, five IR-expansion tests in `smoke.spec.ts` |

`dist/web` went from 36 MB to 11 MB.

### The reader's page had to be rewritten first

The share page rendered with `vditor/dist/method.js` — the rendering half of the editor — so the
dependency could not go until that did. It renders with **the editor's own parser** now:
`remark-parse` with gfm and math, which is what Milkdown reads a note with, so a shared link and the
editor agree about what the markdown means rather than agreeing by coincidence. Two parsers for one
file was itself a source of drift.

Measured, per note, because the reader pays for it:

| | Vditor | now |
|---|---|---|
| prose | 67 KB | 69 KB |
| with a fenced block | 1,091 KB — Vditor ships every language it knows | **239 KB** |
| with maths | +270 KB | +255 KB |
| with a diagram | +2,604 KB | +643 KB |

Highlighting and maths are fetched only when the note contains one, which is what keeps the prose
case where it was. Raw HTML is not rendered at all: a shared link is a public page.

### Two bugs the removal exposed

Both had been there all along and were invisible while the default engine was the other one.

- **Opening a note marked it unsaved.** `replaceAll` is followed by an update event carrying the
  editor's *own* spelling of the same markdown — `|a|b|` comes back `| a | b |` — and against the
  text that was pushed in, that reads as an edit nobody made. So opening a tightly written note
  queued a reformat, which is exactly what "the reformat is done deliberately" above was written to
  prevent. Recording the editor's spelling as what is synced makes the echo compare equal.
- **Saving in source mode wrote the editor's serialisation**, not the bytes in the textarea. The
  mode exists so that what is typed reaches the file as typed; its save handler now stands down
  while it is open.
