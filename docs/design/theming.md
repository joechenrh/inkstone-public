# Theming

Two layers, deliberately separated:

- **App chrome** — sidebar, top bar, status bar, modals. Driven by `--ink-*` tokens.
- **Rendered document** — everything inside the editor, scoped to `.vditor-ir .vditor-reset`.

The split matters because the document is the artifact the user is authoring; it should look like a finished page, not like part of the application UI.

The two layers still have to agree on the page colour: every shell surface uses `--ink-bg`, and the sidebar and the document must not meet as two visibly different shades at the pane border. Structure comes from hairlines (`--ink-rule`), not from tinted panes.

**The document theme owns both layers.** `tokens.css` holds the defaults, and each theme file re-declares the shell tokens alongside its own document rules, so switching a theme repaints the app around the page rather than leaving a seam.

## Document themes

| Theme | Appearances | Character |
|---|---|---|
| Lapis | light, dark | Serif headings, a centred h1, h2 as a white-on-accent pill. Decorates the page. |
| Plain | light, dark | Flat sans, hairlines instead of colour, tighter leading. More of a long file on screen. |
| Aspartate | dark | Converted from Typora |
| Forest | light | Converted from Typora |
| Tailwind | light, dark | Converted from Typora |
| Everforest | light, dark | Converted from Typora |
| BitClean | light, dark | Converted from Typora |

Lapis and Plain are written by hand; the other five are converted (see below) and then corrected by hand.

Each theme is one file nested under `:root[data-doc-theme="<id>"]`; the build flattens the nesting into ordinary descendant selectors, which is what keeps a theme from being 300 hand-prefixed rules. Dark rules attach with `&[data-theme="dark"]`, not a descendant `:root`.

A theme declares **which appearances it has** (`DOC_THEMES` in `src/web/theme/docThemes.ts`). Both built-ins have light and dark, but Typora themes — the intended import path — ship one fixed look per file: `lapis.css` and `lapis-dark.css` are two files, and Drake is twelve. So `clampAppearance` lets the theme override the user's Appearance choice, and the Appearance control goes inert with a reason when the active theme offers no alternative. Without that, choosing "dark" on a light-only theme would leave a dark shell around a white page — precisely the seam the shared page colour exists to prevent.

## Converting a Typora theme

`scripts/convert-typora-theme.mjs` rewrites an upstream stylesheet; `scripts/assemble-theme.mjs` runs it for the light and dark files and appends the finishing every conversion needs. The output is a **starting point that gets read and corrected**, not a build step — the mapping is lossy, and the proportion that survives varies from 12% to 33% per theme.

What the converter does: drops Typora's application chrome, maps Typora's markdown hooks (`.md-fences`, `.md-math-block`, …) onto Vditor's DOM, rewrites `#write` to `.vditor-ir .vditor-reset`, and scopes everything else under that root.

**A theme may not style the application.** Typora themes style bare `input`, `table`, `button` — the whole window is theirs. Nested under our wrapper those reach the login field, the rename box and the sidebar, so every selector is confined to the document root.

Three traps, each of which shipped a visible bug before it was understood:

- **A selector mentioning the document root inside `:not()` is not scoped by it — it means the opposite.** `button:not(#write *)` is upstream's "every button *outside* the document", i.e. Typora's own chrome. Reading the root inside the negation as proof of containment let Everforest paint every button in the app with `!important`, and the whole interface turned olive. Containment is judged on the selector with its `:not()/:is()/:where()/:has()` arguments stripped, and rules that explicitly target outside the document are dropped.
- **Comments are stripped whole-file before parsing.** Upstream themes contain unterminated ones; a stray `/*表格更多菜单` in Aspartate swallowed the rest of the stylesheet and the minifier shipped 17 of 58 rules with only a warning.
- **A palette is a rule that *declares* custom properties**, not one that mentions a `var()`. Matching on the latter hoisted `html, body { background: var(--bg-primary) }` to the wrapper and cost three themes their page colour.

Structural plumbing — which `<pre>` is visible, the collapsed source, the copy button — belongs to `vditor-shell.css` and must not be reintroduced by a theme. A theme supplies palette and typography only.

### The typographic bar, and how it is checked

A conversion's real failure mode is not a syntax error. It is a rule that applies cleanly and lays the page out wrong, because it was leaning on an assumption of Typora's — its DOM, its base stylesheet, its root font size. Reading the CSS does not find those, and neither does looking at one theme in one appearance: four shipped themes had between them a blockquote laid out as two columns, inline code at 100% of body size in `rem`, inline code hung from the top of the line box, list items at a different measure from paragraphs, and a list's bottom margin stacking onto a quote's padding.

So they are **measured**. `tests/e2e/theme-conformance.spec.ts` renders one fixture holding every construct a theme was found breaking — CJK text against inline code, a wrapped list item, a list inside a quote, a table cell, a fenced block, a heading with text under it — under every theme in both appearances, and reports every violation at once. Eight rules:

| Rule | What it caught |
|---|---|
| `inline-code-size` | Everforest at 100% of body, in `rem` — a size change mid-sentence that also ignored the font-size setting |
| `inline-code-baseline` | Forest's `vertical-align: top`, hanging the pill from the top of the line |
| `inline-code-fits-line` | 28px pills in 26px lines, nearly touching the row above in wrapped text |
| `uniform-leading` | List items at 1.5 against 1.8 in a paragraph; 1.0 inside a quote |
| `prose-in-normal-flow` | Everforest's `display: flex` blockquote, which broke the reading order |
| `heading-breathing-room` | 7px under a Lapis h2 whose background is a filled pill |
| `list-exit-symmetry` | 32px after a list against 19px before it |
| `container-inset-symmetry` | 16px above a quote's content and 35px below |
| `table-alignment-honoured` | BitClean overrode `align` on every cell, Everforest and Lapis on the header |
| `table-rows-separated` | A table whose rows have no border, rule or zebra fill is a wall |
| `table-cell-padding` | Text touching the rule beside it |
| `table-contrast` | Vditor's hardcoded light row fills showing through in dark |
| `table-paints-only-its-rows` | ~400px of theme colour painted beside the table |
| `table-rounded-corners-clean` | Square cell borders and fills clipped part-way round a rounded table |

Each theme is also re-measured **at two font-size settings**. `rem` is root-relative and the setting is not, so a rem-based size ignores it outright: four of the five converted themes kept their headings and their fenced blocks frozen while the body text grew from 16px to 22px. At one size a frozen theme looks perfect, which is why the check changes the setting rather than reading a single render. The converter now rewrites `font-size: Nrem` to `calc(var(--ink-font-size, 16px) * N)`, and the same transform was applied to the five themes already generated — 56 declarations.
| `table-header-centred` | Header text 6px from the top of its cell and 12.8px from the bottom |

Two of the table rules are about Vditor rather than the themes. Its stylesheet hardcodes `table tr { background-color: #fafbfc }` and white on the alternate rows, which showed through as a near-white band under light text in **every** theme in dark — and in Aspartate, which is dark-only, in its one appearance. The bar clears it at a specificity that beats Vditor and *loses* to any theme rule, so a theme's own zebra still wins rather than being replaced by one of ours. Vditor also sets `display: block` on tables so a wide one can scroll. That wraps the rows in an anonymous table box which shrink-wraps to its content, with two consequences. A theme that paints the table itself paints the difference as a strip beside it — fixed in the two themes that do, by sizing the box to its content, rather than globally: applying that everywhere squeezed Tailwind Typography's full-width prose tables into 189px of an 840px column. And `width: 100%` widens only the outer block, never the columns, so Tailwind's tables were never full width at all; it gets `display: table` back, trading self-scrolling for the measure its design is built on.

The conformance rule is therefore about painting, not geometry: a box wider than its rows is fine as long as nothing is drawn in the gap.

A column's alignment is the markdown's, not the theme's — and now a toolbar button claims to set it, so a theme overriding `text-align` does not merely restyle a table, it makes the control look broken. The bar therefore pins `text-align` from the `align` attribute on every cell, header included. This costs Lapis its centred table headers, which were a deliberate touch: a control that claims to set something has to set it.

Leading is compared as a **ratio**, not in pixels, so a theme may legitimately set a quote smaller and have its leading scale; tables are exempt, since a table is not running prose. When the suite fails, fix the theme or the bar — widening a threshold to make it pass defeats the point.

The fixes live in `vditor-shell.css` under "the typographic bar". They carry the `:root[data-doc-theme]` wrapper the themes carry, so they outrank any single theme by one class rather than by `!important`; `!important` is reserved for the two properties a theme was found setting that way itself, and for the reading-order guarantee.

### Why all themes are bundled

Measured: the five converted themes add **15.1KB gzipped** to the CSS bundle (29.7KB with them, 14.5KB without). They ship in the one hashed stylesheet, which is served gzipped and cached `immutable`, so that is a one-time 15KB.

Splitting them into on-demand files would buy that back at the cost of a network round-trip and a flash of unstyled document on every first theme switch, and would break the single-file immutable cache. Not worth it at this size. Revisit if the bundled set passes roughly 50KB gzipped, or if themes ever become user-supplied — at that point loading on demand is not an optimisation but the only option.

### What the conformance suite still does not catch

Written down because they are the reason a theme can pass every rule and still be wrong:

- **`rem` outside `font-size` does not scale.** Margins, padding and widths written in `rem` stay fixed while the type grows with the setting. Arguably correct — the setting is about text — but it means a theme's spacing tightens visibly at large sizes, and nothing checks it.
- **Nothing checks appearance, only measurable properties.** Every rule names a specific quantity: a ratio, a gap, a contrast, a computed value. A theme can satisfy all of them and still look wrong in a way no rule describes — a clashing accent, a heading weight that fights the body, a fill that is legible but ugly. Closing that needs a reference-image comparison per theme, rendered and diffed; it does not exist.

Both were found by the same route as everything else here: the user looked at the page and I had not.

## Light/dark resolution

The user picks `light`, `dark`, or `system`. `applyThemeChoice` writes the outcome to `data-theme` on `<html>` and mirrors it into the `resolvedTheme` signal; the `matchMedia` listener for `system` does the same. Both paths must stay in lock-step — `resolvedTheme` is what tells Vditor which chrome theme to load, and a drift between the attribute and the signal shows a light editor inside a dark shell.

All dark rules are scoped under `:root[data-theme="dark"]`, never under a bare `prefers-color-scheme` media query, so an explicit choice always wins over the OS preference.

## Lapis palette

Replicated from the upstream Typora theme (`YiNNx/typora-theme-lapis`); values verified against its source rather than sampled from screenshots.

| Role | Light | Dark |
|---|---|---|
| Accent / primary | `#4870ac` | `#8393ad` |
| Body text | `#40464f` | `#e4e4e4` |
| Page background | `#ffffff` | `#1e222a` |
| Block background | `#f6f8fa` | — |
| Code background | `#f6f8fa` | `#080e1d` |
| Blockquote | — | `#2a2f3b` |
| List marker | `#a2b6d4` | — |
| h2 pill background | `#4870ac` | `#47556d` |

Headings: h1 is centered, accent-coloured, 2rem. h2 is a pill — white text (`color: var(--bg-color)`) on the accent, `padding: 1px 12.5px; border-radius: 4px; display: inline-block`.

The pill's left padding pushes its text 12.5px right of every other heading. An equal **negative left margin** (`margin: 0.3em 0 0.3em -12.5px`) pulls the box back so the *text* aligns with h3–h6 while the pill still has interior breathing room.

List markers are styled through `li::marker` at `0.8em`, small enough not to compete with the text.

## Font size

The editor font size setting writes `--ink-font-size` onto the document element (`settings.ts`), and body text derives from it: `font-size: calc(var(--ink-font-size, 16px) * 1.1)`.

Upstream Lapis uses `1.1rem`, which is root-relative and therefore ignores the setting entirely — the size control appeared to do nothing until every rem-based size in the ported theme was converted to a `calc()` against the token. Any new rule in `lapis-theme.css` must follow the same pattern.

It is persisted to `localStorage` and coerced against an allow-list on read, so a corrupted or hand-edited value falls back to the default instead of producing an unusable UI.

**The sidebar's size is not a setting.** `--ink-tree-font-size` is a fixed 14px. It was a Settings row and two things were wrong with it: the label said "File tree font size" while the token drives five surfaces — the tree, the Files/Outline tabs, the outline, the search field and its results, and the empty state's recent list — and the thing anyone actually wants there is *zoom*, which the browser already does better. Cmd +/− takes the line height, the icons and the indents with it, per site, remembered per display; the setting moved a font size only, so at 16 the rows kept their 14px rhythm. 14px is also where the applications that offer no such choice have landed: measured off a side-by-side screenshot, Yuque's sidebar has the same CJK glyph height as ours, in rows 6px taller.

## Fonts

Rendering fonts are vendored and declared in `src/web/editor/fonts.css`. No `@import` from a font CDN — see the no-external-CDN invariant in [architecture.md](architecture.md).

**They are subset, and they carry a `unicode-range`.** The full Source Han Serif faces were 8.2MB and 8.8MB; being woff2 they are the one thing gzip cannot touch, so on a cold load they were 17MB of an 18.3MB critical path — 94% of it — against about 1.3MB for everything else combined once compressed. They now carry GB2312 level 1 (3,755 hanzi, the standard common set) and CJK punctuation, and nothing else: 1.0MB and 1.1MB. `scripts/subset-fonts.py` regenerates them and explains the trade; a character outside the set falls through to Songti SC by ordinary font fallback.

The `unicode-range` is the other half and it matters more than the subsetting for anyone writing in English: without it a browser fetches a face the moment any character selects it, and `empty-state.css` names the CJK serif *first* — so opening the app with no note yet pulled eight megabytes to set one English sentence. Measured cold, editor to first render: **22.6MB → 4.5MB for a note with no Chinese in it, and → 7.7MB for one with.**
