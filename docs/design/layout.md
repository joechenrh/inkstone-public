# Layout

`src/web/layout/shell.css`. The guiding constraint: **the text column never moves.** Reading and writing prose is the whole activity, and a column that shifts when a panel opens or a notification appears breaks the line the user is on.

## Shell

`.ink-shell` is a two-column, three-row grid — top bar across the top, sidebar and editor side by side, status bar under the editor only — filling the viewport. `html`, `body`, and `#root` are `overflow: hidden`; nothing scrolls except the sidebar's active view and the editor's own internal scroller. Without that, the entire application could be dragged around on trackpads and touch devices.

There is no `.ink-body` wrapper: the sidebar has to be a direct grid item to span the body and status rows, and a wrapper would prevent that. `.ink-center` is the positioning anchor (`position: relative`) for the floating drawer and the conflict bar.

## Left sidebar

A grid item at `--ink-left-width` with a right rule, spanning the body **and** status rows so it runs to the bottom of the window. Opening and closing it *does* resize the center column, which is the expected behaviour for a file tree.

It holds two views — the file tree and the document outline — and shows one at a time. The header is a single row: two tabs on the left, and a `+` pinned to the right that opens a create menu scoped to the vault root. `Cmd/Ctrl+1` and `Cmd/Ctrl+2` switch views without the mouse.

Per-row actions sit behind one `⋯` menu rather than a row of icons. A folder row previously carried four — new file, new folder, rename, delete — which was crowded not because the glyphs were poor but because "create" had two entry points, the header and every row. Collapsing the row's actions into a menu and the header's into the same kind of menu leaves the sidebar with one interaction language: a glyph that opens a menu.

The tabs are **labelled**, not bare icons: two abstract glyphs alone do not say "files" and "outline", and the sidebar has the width to spell it out. Hovering either one paints a grey rounded chip, so the hit target is visible before the click; the selected tab takes the accent colour and keeps it while hovered — the chip appears, the colour does not change under you.

Switching rather than stacking them was the deliberate call. Stacking keeps both visible, which is what an outline is really for — glancing to see where you are, with no action at all. But at 260px the two share a width that truncates deeper headings, and a long document pushes the outline to its height cap and squeezes the tree, degrading exactly when the outline matters most. A keyboard shortcut recovers most of switching's cost; nothing recovers stacking's. The stacked variant is specified in full in `docs/superpowers/specs/2026-08-11-inkstone-outline-panel-design.md` §7 if the trade ever looks different.

**The git controls live in the status bar, pinned bottom-right** — branch, dirty dot, commit, push — beside the document's word and character counts.

They were briefly hosted in a sidebar footer, on the reasoning that they describe the vault and the sidebar shows the vault. That was wrong for a concrete reason: `Cmd/Ctrl+\` unmounts the sidebar, so collapsing the file tree silently removed every git affordance. A fallback that re-hosted them in the status bar while collapsed worked, but meant one control with two homes and a visible jump between them. Pinning them to the status bar is simpler and never moves. Anything vault-scoped proposed for the sidebar has to answer the collapsed-state question first.

## Separating panes

Panes are separated by a hairline, not by a fill. Every shell surface — sidebar, top bar, status bar, editor — shares `--ink-bg`, and a 1px `--ink-rule` draws the boundary. Tinting a pane to mark it off reads as heavy at this density, and it was the first thing that looked wrong next to Yuque. The drawer carries no shadow for the same reason.

## Right panel: a floating drawer

`.ink-right` is `position: absolute` inside `.ink-center` with `top/right/bottom: 0`, `z-index: 10`, and a left rule, so it takes no layout space and opening it never reflows the text.

It currently holds nothing. The outline moved to the sidebar, and it now holds two tabs, History and Agent ([agent.md](agent.md)). The tab strip is the whole
control — a feature that size earns one Settings row and a drawer that already exists, not a button
in the top bar. Both tabs stay mounted and are hidden with `hidden`, because the history panel
refetches on mount and switching tabs to read an answer should not cost a round trip. Do not convert it back into a flex child — that would make every toggle reflow the document.

Motion is asymmetric, matching Yuque: `animation: ink-panel-slide-in 0.18s ease` plays once on mount, and closing unmounts the element outright so it disappears instantly. Waiting on an exit animation to dismiss a panel reads as lag.

## The content column

The editor's scroll container spans the full width of `.ink-center`, so its scrollbar is painted against the window edge rather than stranded mid-screen. Inside it, **the measure is 750px and the left edge is fixed**:

```css
.ink-editor .ink-doc      { padding: 32px calc(var(--ink-gutter) + var(--ink-reserved)) 40vh var(--ink-gutter) !important; }
.ink-editor .ink-doc > *  { max-width: var(--ink-content-width) !important; }
.ink-center--drawer .ink-editor .ink-doc { --ink-reserved: var(--ink-right-width); }
```

The gutter is a flat `56px` — the floor the heading markers live in, since Vditor floats `##` into it and Lapis's h2 pill overhangs its column by a further 12.5px. The `!important` is load-bearing: Vditor sets `padding` inline on `.vditor-reset` in IR mode, and an inline style yields only to an author `!important`.

**The blocks are capped; the padding is not computed.** The obvious version — `padding-right: max(gutter + drawer, 100% - gutter - measure)` — is wrong in a way that only shows in a real browser: a percentage padding resolves against the *containing block*, which here is 8.8px narrower than the scroller itself, so every note came out that much wide of its own measure. Capping the blocks needs no arithmetic at all. A block is left-aligned in its parent's content box by definition, which *is* the left-anchoring, and the compression falls out of it: when the drawer's reservation leaves less room than the measure, the blocks have less and take it.

**A panel takes the margin before it takes the text.** Measured, sidebar open, paragraph width:

| Window | Drawer shut | Drawer open |
|---|---|---|
| 1280 | 750 | 588 |
| 1512 | 750 | 750 |
| 1920 | 750 | 750 |
| 2560 | 750 | 750 |

The left edge is 316px in every one of those, which is the property that matters: opening a panel beside the words never moves them, and on any screen with room it does not change them either.

This replaced an unconditional reservation of the drawer's 320px, which held the column in one place by taking that width whether the drawer was open or not. The bill was paid entirely by the smaller screen — a 1280 laptop had 588px of text and 320px held empty for a panel that was not open — and the column was centred in what was left, which put it 600px from the sidebar on a 2560 monitor. Chosen against Yuque, which holds one measure on every display; the difference from Yuque is that this one is anchored left rather than centred.

## Scrollbars

Thin, low-contrast thumb, no track, tokenised as `--ink-scrollbar-thumb`, styled **only** through the `::-webkit-scrollbar` pseudo-elements.

The standard `scrollbar-width`/`scrollbar-color` are deliberately not used. Setting either one hands the scrollbar to the standard path, which on macOS honours "Show scroll bars: When scrolling" — an overlay bar that is invisible at rest and takes no layout space — and it also makes Chrome ignore the pseudo-elements entirely. The pseudo-element path forces a persistent, always-visible bar, which is what a long document needs. Firefox falls back to its default scrollbar; acceptable for a self-hosted single-user tool.

## The phone

Below **720px** the app is one screen at a time. The breakpoint is deliberately not about touch: a landscape phone or any tablet keeps the two-pane layout, which is comfortable at that width. The phone layout exists because 390px cannot hold two panes.

Measured before it existed, on a 390px screen: the sidebar took 260px, and the content column's gutter — which reserves half the leftover width plus the right drawer's 320px — resolved to 56px left and 376px right inside the 130px that remained. The text was laid out at **zero width**, one character per line. Tapping into the document and typing already worked once given room, which is why this is a layout, not a second application: the same components, the same state, one screen at a time.

| | |
|---|---|
| Navigation | The list and the document are two screens. Opening a note pushes to it; back returns to the list **without closing the file**, so returning costs no reload and loses no draft. |
| Top bar | Back, the title, and an overflow menu. Six icons across 390px is neither reachable nor legible. |
| Bottom bar | The view control and Save, where a thumb is. Save is a button because there is no Ctrl+S on a phone and manual save is the whole protocol — without it the only route to disk is the five-minute autocommit. |
| Read-first | A note opens in **read** on a phone. Phones are mostly where you look something up, and read mode already stops a stray tap expanding a block's markers — which on a touch screen is most taps. Not applied on a desktop, where the reading posture is a remembered preference rather than a per-open default. |
| Git feedback | A transient line above the bottom bar. There is no status bar on a phone — the desktop's git footer, which carries the branch and the error line, is not rendered here — so tapping Push closed the menu and that was the whole of it: measured, nothing at 150ms, 500ms or 1200ms. The silence covered failures too, which is what decided the shape: this is not a success chirp but the only place a git action can speak. Working and done clear themselves; a failure stays until dismissed, being the one you might need to read twice. Commit uses the same line. |
| Sheet height | Fixed, not content-sized. History fetches its log on mount, so a content-sized sheet opened at half height and then expanded — two stages where there should be one. A detent that does not depend on what is inside it cannot do that, whatever the content is doing; a short outline leaves space below the list, which is what every bottom sheet does. |
| History | A sheet, from the ⋯ menu. As a drawer it replaced the note with no scrim and no close, and the back arrow goes to the list rather than out of history — so the only way back was the menu that opened it. The same `PhoneSheet` the outline uses. The panel's own "History" eyebrow is hidden because the sheet's title says it, and the note's modified time and size move up into that title row as a subtitle — inside a sheet called History they were a block that was not history. |
| Bottom bar | The view group and Save, both 48px trays. Save was a 36px outlined pill beside a 48px tray: two kinds of control in one bar, and under the 44px floor every other touch target here holds to. It takes the accent only when there is something to save, which is the one moment it is a button rather than a label. |
| Outline | A sheet over the note, from the ⋯ menu. It is a sidebar tab, which on a phone lives on the *other screen*: reaching it while reading cost back, switch tab, tap a heading, and being pushed back into the note — three taps and two screen changes to jump within the document you were already in. Two taps and none now. Modal, so the bar behind it is covered; picking a heading closes it, since that is the only reason to open it. |
| Table menu | Long-press a cell, since there is no right-click. Cancelled by movement or an early lift, so it never fires on a scroll. |
| Tap targets | 44px minimum under `(pointer: coarse)`; the bar's icons are 28px with a pointer. |
| Keycaps | Hidden under `(pointer: coarse)` — a chip reading ⌘⌥N on a device with no ⌘ names a key that does not exist. |
| Sheets | The history drawer and Settings fill the screen. Settings was 749px tall inside a 664px viewport, with its buttons unreachable — and once it filled the screen it had no way out, since its only exits were the backdrop it now covers and an Escape key a phone does not have. It has a close button at every size for that reason. |
| Safe areas | `env(safe-area-inset-*)` on both bars, and `100dvh` rather than `100vh` so the soft keyboard does not put the bottom bar under itself. |

## The top bar

Left: the file-tree toggle and the breadcrumb. Right, in order: the **view group**, the right-panel toggle, a hairline, and Settings.

**Edit, read and source are one setting with three values**, not three switches. They were two independent flags, which allowed "read-only source" — a state neither control described and neither icon showed. `viewMode` in `settings.ts` is now the single value; `readOnly` and `sourceMode` are `computed` from it, so the rest of the app is unchanged. Only the reading posture is persisted: `source` is coerced back to `edit` on load, because source mode is somewhere you go to fix one thing and starting there after a reload would be a surprise.

The group is a tray with the selected view lifted onto the page colour, which is the claim being made — one control, one answer. `Cmd/Ctrl+E` selects read (and leaves source, since the key asks for reading); `Cmd/Ctrl+Alt+M` selects source and returns to edit.

Settings sits past the hairline because it configures the app rather than the document, and it is what remains when the document-scoped half is gone.

**A control that acts on the open document is not there when there is none.** With no file open the view group, the right-panel toggle (its drawer holds *this file's* history), the word and character counts, and the hairline all go; the file-tree toggle, Settings and the git state stay, because they describe the app and the vault. Source mode already behaved this way on its own, which is what made the others look wrong beside it.

## Search

One field at the top of the Files panel, and one list. Typing searches names and text together;
results take the tree's place in two labelled groups — **Notes** for name matches, **In the text**
for the rest — and clearing brings the tree back exactly as it was.

**Search runs in the browser.** It asked the server on every keystroke first, and that is why it
felt slow next to VS Code and Typora: those search local data. Everything the network version
needed to survive a round trip was a symptom of the wrong shape —

- a debounce, so a remote machine was not walked per keystroke;
- a stale-response guard, because the answer to what you typed a moment ago could arrive after the
  answer to what you are typing now;
- a "Searching…" state that emptied the list it was about to refill, which over a slow link read
  as results flashing up and vanishing;
- a two-character minimum to keep the cost down, which is why "1" found nothing in the text and
  "11" found something — a rule nobody could guess.

All four are gone, along with the code for them. `/api/corpus` returns the vault's markdown once;
searching is a string scan over it. Measured on the real vault: **2,271 bytes, 1,220 gzipped** — a
hundred times that is still a rounding error beside the editor bundle. The copy is dropped whenever
the tree changes or a file is saved, and refetched on the next search, because the alternative —
patching it in place — is a second source of truth to keep in step.

Capped at 8MB total and 512KB per note, and it says so rather than quietly covering half the vault.
The only transient state left is "Loading the vault…", once per session, on the first search.

Details that were each a defect first:

- **A hit goes to the match.** The results said "here is where it is" and opened the note at the
  top — on a 76,000px note that is not an answer. The line number cannot be used directly, since the
  rendered document has nodes rather than lines, so the text is the anchor: the query is found in
  the rendered document and **selected**. Selected rather than wrapped in a mark, because an element
  put there is inside the editable surface, becomes part of the document, and is written to the file.
- **A note that matches both ways keeps its excerpt.** Dropping the text hit for a file whose name
  already matched threw away where in the text it matched.
- **The excerpt is a short window around the hit.** Taking the first 200 characters of the line
  produced rows whose matching word was off the end of them; centring it was not enough either,
  since the row is one clipped line in a 250px panel. Twelve characters of lead.
- **Focus goes on the field, not the input.** The shell's ring stands 2px outside whatever has
  focus, which is right for a button and wrong for an input already inside a bordered box — it drew
  a second rectangle around the first. The field takes the accent border and a low-opacity halo,
  which is what GitHub, Linear and most current form systems do.

## The empty editor

With no file open the editor column shows a card borrowed from VSCode's welcome screen: a faint wordmark, then two labelled groups of rows — **Recent** (note name left, the folder it lives in right) and **Start** (action left, its keycaps right). No buttons anywhere. The two groups share a right edge, so the folder paths and the keycaps line up down one column.

It replaced a pair of bordered buttons that were the only chrome on an otherwise quiet page. The keycap is the reason the borrow works: this is the screen you look at whenever nothing is open, so it is the one chance to teach the shortcut, which means **every chip has to name a key that actually does something**. `New note` and `New folder` therefore came with two new shortcuts rather than the other way round.

Recent is conditional — a heading over an empty list is worse than no list — and Start is not, since the actions do not depend on having a history. "This vault is empty." appears only when there is also nothing in the sidebar to pick.

It renders *over* the editor rather than replacing it: tearing the Vditor instance down and rebuilding it on every open and close is expensive and loses the editor's own state.

## Creating from the keyboard

`Cmd/Ctrl+Alt+N` creates a note, `Cmd/Ctrl+Alt+F` a folder. Alt because the conventional keys are not available to a web app: the browser keeps `Cmd+N` for a new window and `Shift+Cmd+N` for an incognito one, and neither event is ever delivered to the page.

Two things this depends on:

- **Matched on `e.code`, not `e.key`.** Holding Option on macOS rewrites `key` to the composed character, so `Cmd+Alt+N` arrives as `"˜"`. Everything else on Ctrl/Cmd+Alt passes through untouched, because digits 1–6 are Vditor's heading levels.
- **`beginCreate` switches the sidebar to the file tree first.** The name is typed into an inline input that lives *in* the tree, and the tree is unmounted whenever the outline is showing or the sidebar is collapsed — so without that the shortcut silently does nothing.

The inline create input is focused explicitly, in a layout effect. `autoFocus` does not work for it: the attribute only applies while the document's autofocus flag is unset, which the login form's password field already consumed, so an input mounted later opened unfocused — Escape cancelled nothing and the name had to be clicked into before it could be typed. That was a live bug in the buttons too; it only became load-bearing once a keyboard shortcut existed, since not touching the pointer is the entire point of one.

## Conflict bar

`.ink-conflict` is absolutely positioned and centered near the top of `.ink-center`, outside the layout flow. A conflict notice appears at an unpredictable moment; as an in-flow banner it would push the entire document down mid-sentence. As a floating card it covers a strip of the editor and changes nothing underneath.

## File tree

30px rows with a 3px accent bar on the left of the selected row, which is always present but at `opacity: 0` / `scaleY(0.5)` on unselected rows so selection animates rather than popping in. Row actions are `opacity: 0` until hover. Inline rename/create uses a rounded input with an accent border and a soft focus ring.

## Swiping back, on a phone

Swipe right anywhere on the document to return to the list. `useSwipeBack` in `src/web/layout/` owns it.

**Touch events, and `preventDefault` rather than `touch-action`.** Pointer events worked against synthetic ones and not at all on a phone: a moving finger is a scroll as far as the browser is concerned, so it takes the gesture over and fires `pointercancel`, and no further move arrives. The usual answer — `touch-action: pan-y` on the pane — cannot be used, because touch-action is intersected up the ancestor chain: forbidding horizontal panning on the pane forbids it inside the tables and code blocks too, which is the scrolling this gesture exists to leave alone. Calling `preventDefault()` on `touchmove`, and only once the drag has proved itself horizontal, claims this gesture and nothing else. Verified with real touch input through CDP rather than dispatched events: a 200px swipe goes back, vertical scrolling still moves the document 325px, and a table still scrolls sideways by 264px.

**The document does not move; the whole list travels in over it, from the left.**

Moving the document right and letting the list sit behind it was the first attempt and uncovered the shell's own background — the phone mounts one screen at a time, so there was nothing back there — with the list appearing only once the finger had gone. Mounting the list underneath fixed that but put the thing being read in motion, which reads as the page being dragged away rather than as a menu arriving.

So the list is a panel that travels, and the document is still. The cost is geometric and worth knowing: a full-width panel entering from the left leads with its *right* edge, so mid-drag the strip on screen is the right side of the list rather than the filenames. Masking it instead — `clip-path` from the left — puts every row where it will finally be and shows the names immediately, but it is a shape being unmasked rather than a menu moving, and the movement is the point.

**The arriving panel is a whole screen, header included.** It spans the shell's first two grid rows and carries its own `TopBar` in list form (`forceList`) — without it the menu starts below the document's bar and reads as a screen with its top cut off. That in turn requires the phone's `.ink-topbar` to name its own `grid-row`: it was auto-placed, so an item claiming rows one and two pushed it into a row of its own and put the document's header at the bottom of the screen for the length of every drag.

**A release finishes the travel rather than teleporting.** The panel animates the rest of the way and the screen changes when it arrives; clearing the transform at the moment the finger left put it in place with a jump. `phoneSwiping` keeps the list mounted for that animation and for a spring-back, so neither is pulled out from under itself.

`Shell` passes the centre pane as a **callback ref** rather than a `useRef` — the pane is mounted only on the document screen, and a `useLayoutEffect` keyed on `ref.current` never sees it appear, because the ref is still null while the render that creates the element runs. The unit tests missed that; driving a real browser found it.

The gesture is the rare addition that costs no interface, and it is invisible, so the top bar's `‹` stays. Three things shape it:

| | |
|---|---|
| It starts anywhere, not at the edge | iOS uses the edge for browser back, and that is not a fight worth having |
| It never arms inside an element with `scrollWidth > clientWidth` | Tables and code blocks are deliberately `overflow-x: auto`; that drag is theirs |
| It is off while a sheet is open, while text is selected, and for anything that is not a touch | A sheet covers the document, a selection means the finger is busy, and a mouse drag on a narrow window is not this |

72px to commit, and `dx > 2 × |dy|` throughout — a diagonal is scrolling with a wobble. The direction is decided once, when the drag passes 6px of slop; re-deciding it mid-gesture is what makes a pane twitch under a scrolling thumb.

## The sidebar, on a phone

No view switcher, and no outline. It cannot have one: `OutlinePanel` reads headings out of `.vditor-ir .vditor-reset`, and on the list screen `Shell` renders the sidebar *instead of* the document — so the editor is not mounted, the selector finds nothing, and the panel reported that as "No headings in this note" about a note it could not see. Measured on a note with three headings: desktop three items, phone zero. It was not a redundant tab but an always-empty one that reads as an answer.

The outline already has a working home there, as a sheet over the document. With one view left, `+` joins the search row — the only other row that acts on the list.

`Sidebar` ignores the stored `sidebarView` on a phone rather than resetting it: narrowing the window while on the outline would otherwise strand someone on a panel with no switcher to leave by, and widening it again restores what they chose.

## 44px, on a phone

Everything touched with a thumb is at least 44px tall below 719px. That was already true of the bottom bar, the commit panel, the sign-in button and the repository rows, and false of everything else — measured by walking the phone screens and listing every button, link, menu item and row shorter than 44:

| | Was | Now |
|---|---|---|
| File tree row | 30px, identical to the desktop's | 44px on a phone only |
| A row's `⋯` | **20×20** | 44×44 hit area, same glyph |
| Top bar menu items | 33px | 44px |
| Outline rows | 26px | 30px on a desktop, 44px on a phone |
| Appearance buttons | 29px | 44px |
| Both font-size selects | **25px** | 44px |
| Log out | 33px | 44px |
| Search field and `+` | 36px | 44px |

The tree measurement is the one worth keeping: it was 30px on the phone *and* 30px on the desktop, so the fault was that they were identical rather than that they differed. A pointer is precise and the desktop's column is 259px wide; a thumb is not and the phone's is 390. Seven fewer files fit on a phone screen, and the search field above the tree is the better answer to a list too long to scroll.

The `⋯` on a tree row grows its hit area without growing its glyph — the region that answers a tap is not the region that has to be drawn.

## Two things the phone reserved and did not use

**The outline sheet fits its content; history keeps the fixed detent.** The detent exists because a sheet sized by its content opened at whatever the panel had ready and grew when the rest arrived — history fetches its log on mount, so it appeared half-size and then expanded. The outline has no such excuse: its headings are read from the document synchronously, so the list is complete on the first paint. Two headings now make a 180px sheet instead of a 471px one with two thirds of it empty; twelve still cap at 62dvh.

**The bottom row collapses when there is no bar in it.** With no file open `PhoneBar` renders nothing, and a fixed 52px row reserved an empty strip below the list — visible as a hairline and a band of nothing on a screen that has no bar at all. The row is `auto` and the bar carries its own height and the home indicator's inset. Measured: 0px with no file open, 61px with one.

## One rhythm per column

The outline and the file tree share the sidebar, so they share a row height: 30px on a desktop, 44px on a phone. The outline was 26 at the same font size and line height, which left its text 1.8px of air where the tree's has 3.8 — and it was the list holding headings, which are longer than filenames and truncate, so it was the one that needed more rather than less.
