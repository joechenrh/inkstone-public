# Inkstone Phase 1 Design — Vditor IR Rendering + Lapis Theme

On top of Phase 0/0.5 (a usable server-hosted markdown editor: vault, git, auth, file-tree CRUD, manual save, settings, top/status bar), add **live markdown rendering**.

**Core decision (brainstorm outcome):** replace the existing CodeMirror editor with **Vditor's IR (instant rendering, Typora-like) mode**, self-host its assets, and **replicate the Lapis theme** visually (including its original fonts), with the theme following the light/dark setting. Save, file tree, and git integration carry over from Phase 0.5. A system for downloading and installing arbitrary themes from theme.typora.io is deferred to a later phase.

## Background and existing constraints

- Current editor: CodeMirror 6, plain source mode (Phase 0.5 manual save). `document.ts` owns the save model (`content`/`dirty`/`baseMtimeMs`/`conflict`/`saveError`, `editContent`/`flushSave`/`openFile`/`handleExternalChange`/`resolveConflict*`, localStorage drafts) and is decoupled from the editor component.
- Frontend: Preact + @preact/signals; three design disciplines (no rounded corners [except 3px on code blocks], no shadows [except overlays], 1px hairline dividers between panels added in Phase 0.5); colors centralized in `tokens.css`; Maple Mono for the chrome.
- Backend: Fastify serving `dist/web` statically (SPA fallback; `/api/*` and `/vault/*` behind auth; index.html no-store, hashed assets immutable). The service binds only to an intranet/Tailscale address and spawns a sandboxed codex on the server — **depending on an external CDN or network is forbidden**.
- Testing: Vitest split into `web` (jsdom) and `server` (node) projects; a full `pnpm vitest run` is unreliable because the two projects run concurrently, so **per-project runs are authoritative**. Known intermittent: the `VaultWatcher mtime grace period` test has timing flakes under a full run (technical debt).

## Verified Vditor integration facts (3.11.2, MIT, framework-agnostic TS)

- `new Vditor(el, { mode: 'ir', ... })` — IR = instant rendering (Typora-like).
- `getValue(): string` / `setValue(md: string, clearStack?: boolean)`.
- Callbacks: `input(value)` (fires after an edit), `keydown(e)` (raw keyboard, for intercepting Ctrl/Cmd+S), `ctrlEnter`, `after` (initialization complete).
- Theme: `options.theme` = `'classic' | 'dark'`; content theme via `options.preview.theme.{current,list}`; at runtime `setTheme(theme, contentTheme?, codeTheme?)`.
- Assets: by default pulls the lute wasm, icons, highlighting, and formula assets from `unpkg`; `options.cdn` and `preview.cdn` can point at a self-hosted path.

## Settled decisions

| Decision | Choice |
|---|---|
| Rendering approach | Vditor IR mode (route 2), replacing CodeMirror |
| CodeMirror | Remove the `@codemirror/*` dependencies and CM code entirely |
| Editing/rendering coexistence | Single-column IR WYSIWYG (no separate preview pane or split view) |
| Visuals | Replicate Lapis (hand-written content theme CSS; do not consume Typora's native CSS) |
| Rendering fonts | Lapis's own fonts (Cantarell / Source Han Serif CN / JetBrains Mono), self-hosted via @font-face; chrome keeps Maple Mono |
| Theme scope | Built-in Lapis light + dark, selectable under "Render theme" in settings (structure reserved); a download/install system comes later |
| Assets | Self-host Vditor's assets (`cdn: '/vditor'`); no external CDN |
| Save / file tree / git | Carry over from Phase 0.5, rewired to Vditor's input/keydown/setValue |

## 1. Architecture: Vditor IR replaces CodeMirror

**Untouched**: the `document.ts` save model, `vault.ts`/file tree, the entire backend, `settings.ts`, `state/git.ts`, `TopBar`/`StatusBar`, `SettingsModal`. All of these are decoupled from the editor.

**Replaced**: delete `src/web/editor/Editor.tsx` and `src/web/editor/setup.ts` (CM); add `src/web/editor/VditorEditor.tsx`, which calls `new Vditor(...)` internally. App.tsx's center column renders `<VditorEditor />` in place of `<Editor />`. Remove the `@codemirror/*` dependencies from `package.json`.

**Editor ↔ state wiring** (Phase 0.5's integration rewired to Vditor):
- `input(value)` → `editContent(value)` (sets dirty + writes the draft; no automatic persistence).
- `keydown(e)` → if `(e.metaKey||e.ctrlKey) && e.key==='s'`: `e.preventDefault()` + `void flushSave()`.
- Opening a file / a `handleExternalChange` reload / `resolveConflictTakeDisk` → `vditor.setValue(content, true)` (clearStack: rebuild the undo stack on a file switch or reload). **setValue must not trigger `editContent`** (see §6 on sequencing).
- File switching: the logic equivalent to the existing `Editor.tsx` `lastPathRef` is implemented with setValue + resetting dirty.
- The dirty dot (breadcrumb + file-tree row), beforeunload, and refreshing git status after Ctrl+S — the data sources (`dirty`/`currentPath`/`git`) are unchanged, so these keep working as before.

`VditorEditor.tsx` creates the Vditor instance in a `useEffect([])` and does its first `setValue(content.value)` in the `after` callback; on unmount it calls `vditor.destroy()`. A `useEffect([content.value, currentPath.value])` calls `setValue` when the content changes for reasons other than user input (open / reload / conflict), using the same "skip if the values are equal" guard as Phase 0.5 to avoid feeding the value back.

## 2. Self-hosting Vditor's assets

No external CDN. At build time, copy the subset of `node_modules/vditor/dist` that IR needs into `dist/web/vditor/`: the lute wasm, icons, and the content-theme and code-theme in use (plus the CSS/JS that IR depends on). Add a copy step to the vite build (vite `publicDir`, or a small copy plugin/script). At runtime set `options.cdn='/vditor'` and `options.preview.cdn='/vditor'`. In development (`pnpm dev:web`) point at the same local copy or have the dev server serve it.

**Verification**: load the editor under Playwright and assert there are no network requests to external domains such as `unpkg` or `jsdelivr` (allow-list check via `page.on('request')`), and that IR renders correctly.

## 3. Lapis content theme + rendering fonts

### 3.1 Lapis content theme

Add `src/web/editor/lapis-theme.css` (plus `lapis-dark`), reproducing the captured Lapis values, scoped to Vditor's IR render DOM (`.vditor-ir` / `.vditor-reset` and their descendants). Register them in `preview.theme.list` (`lapis` / `lapis-dark`), with `current` defaulting to `lapis`. Key reproduced values (light):

| Element | Value |
|---|---|
| Body | color `#40464f`, font-size `1.1rem`, line-height `1.6`, max-width `950px` centered |
| Accent / links | `#4870ac` |
| Background | `#ffffff`; block background `#f6f8fa` |
| h1 | `2rem`, `#4870ac`, **centered**, 0.9rem above and 2.3rem below |
| h2 | `1.5rem`, **white text on a `#4870ac` background, padding 1px 12.5px, radius 4px (pill)** |
| h3 | `1.4rem` `#4870ac`; h4 `1.2rem`; h5/h6 `1.1rem`; h4–h6 normal weight |
| blockquote | 3px `#4870ac` on the left over a `#f6f8fa` background, padding 15px 30px 15px 20px, 0.9em |
| Inline code | background `#f6f8fa`, text `#4870ac`, 94%, padding 2px 4px, radius 3px |
| Fenced code | background `#f6f8fa`, text `#4f5467`, padding 1.2rem 0.8rem, radius 10px |
| List markers | `#a2b6d4` bold; table border `#d9dfe4`, header `#4870ac` bold centered, hover `#f6f8fa`; hr 2px `#eef2f5` |

For dark `lapis-dark`: during implementation, fetch `lapis-dark.css` from the Lapis repository (`https://raw.githubusercontent.com/YiNNx/typora-theme-lapis/main/lapis-dark.css`) to get the exact dark variable values (deep blue background, light text, blue-family accent) and reproduce them with the same structure — do not invent dark values. Lapis's colors **do not go into the chrome's tokens.css**; they stand alone (in `lapis-theme.css` / the `lapis-dark` section) so they stay decoupled from the application chrome's palette.

The authoritative source for the light values is likewise the repository's `lapis.css` (the values in this table were captured from that file); the repository file governs during implementation, and this table is for cross-reference.

### 3.2 Self-hosted rendering fonts

Self-host three faces via `@font-face`, served from `dist/web/fonts/`, applying **only to the render area** (Vditor's content container) and not to the chrome (Maple Mono):
- Latin body: Cantarell (not present locally → self-host)
- CJK body: Source Han Serif CN (not present locally → self-host); fallback `"Songti SC"` (ships with macOS)
- Code: JetBrains Mono (present locally, still self-hosted for cross-machine consistency)

Font files go in `src/web/fonts/` or directly in `dist/web/fonts/`, copied at build time. Size in exchange for Lapis fidelity — accepted.

## 4. Themes in settings

The settings modal already has "Appearance (system/light/dark)". In Phase 1:
- The app's three-state theme **drives both** the chrome (the existing `applyThemeChoice` + tokens) **and** Vditor: light → `setTheme('classic','lapis')`; dark → `setTheme('dark','lapis-dark')`; `'system'` follows `matchMedia` and syncs Vditor on change. Put this coupling in one place (e.g. `settings.ts` or an `applyRenderTheme()`), with `VditorEditor` subscribing to the theme signal and calling `setTheme` on change.
- Add a "Render theme" dropdown whose only option is currently `Lapis` (structure reserved; later themes and downloads hang off this). Default Lapis. Switching calls `setTheme` immediately.

## 5. Test strategy

Vditor is a heavy contenteditable + wasm library, and jsdom cannot reliably unit-test its internals. Therefore:
- **Vitest unit tests (still full coverage, decoupled from the editor)**: the `document.ts` save model, `settings`, `state/git`, `vault` operations — unaffected by this phase, and must stay green.
- **Playwright e2e (the primary surface for editor behaviour; real build + real Vditor)**: opening a file shows the Lapis IR render (assert the h2 pill background, blue headings, centered h1); typing → the dirty dot appears; Ctrl+S → the dot disappears and the content is persisted (still there after reload); switching light/dark → the render theme changes; **no external CDN requests** (allow-list check); switching files does not bleed content.
- **A shallow smoke test for `VditorEditor.tsx`**: it mounts, `setValue`/`getValue` round-trips, and unmounting via `destroy` does not throw (the minimal assertions jsdom can pass; if Vditor cannot be instantiated in jsdom at all, the component is covered by e2e only and the report says so).

## 6. Error handling and edge cases

| Scenario | Handling |
|---|---|
| Vditor assets (wasm/theme) fail to load | Show an explicit error in the editor area rather than a blank screen; the error must not contain absolute server paths |
| `setValue` triggering `input` and falsely marking dirty | An external reload or an open using `setValue` must not trigger `editContent` — either short-circuit the `input` callback with a "programmatic set in progress" flag, or confirm that Vditor's `setValue` does not emit `input` (verify during implementation and pick one) |
| Sequencing between opening/switching files and user input | Carry over Phase 0.5's "skip if the values are equal" guard; setValue uses `clearStack=true` to rebuild the undo stack |
| Deleting the currently open file | Carry over Phase 0.5's `closeDocument`; the editor clears via `setValue('')` |
| Conflict (409) / external change | Carry over `handleExternalChange`/`resolveConflict*`; taking the disk version → `setValue(diskContent)` |

## 7. Explicitly out of scope (deferred)

- A system for downloading and installing arbitrary themes from theme.typora.io; general Typora theme compatibility; multiple render themes (Phase 1 is Lapis light/dark only).
- Vditor's WYSIWYG (rich text) mode and split-preview mode (IR only).
- Real-time collaboration, standalone visual table editing, mobile.
- Technical debt (not this phase, recorded for the record): switch the `VaultWatcher mtime grace period` test to an injected clock; serialize the two vitest projects; git endpoint 401 tests; a focus trap for the settings modal.

## 8. Delivery impact

- `package.json`: +`vditor`, −`@codemirror/*`.
- Build: vite copies the Vditor dist subset and the rendering fonts into `dist/web/{vditor,fonts}/`.
- Bundle size increases (Vditor wasm + fonts); acceptable for an intranet personal tool.
- All editor unit tests migrate off CM: CM-related tests are deleted and editor behaviour moves to e2e coverage; state tests such as `document.ts` are unchanged.
