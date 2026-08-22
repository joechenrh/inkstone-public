# Inkstone Phase 1 Implementation Plan — Vditor IR + Lapis

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CodeMirror with Vditor's IR (instant rendering, Typora-like) mode, self-host its assets, replicate the Lapis theme for rendering (including its original fonts), and follow the light/dark setting; Phase 0.5's manual save, file tree, and git integration carry over.

**Architecture:** Vditor (vanilla TS, MIT) is instantiated inside a single `VditorEditor.tsx` with `mode:'ir'`. The `document.ts` save model is unchanged and is rewired through `input`/`keydown`/`setValue`. Vditor's assets and the Lapis rendering fonts are self-hosted under `public/` (served automatically by vite in dev, copied into `dist/web` on build) with `cdn:'/vditor'` and no external CDN. Lapis becomes a Vditor content theme (light/dark), and the app's three-state theme drives `vditor.setTheme` through a resolved-theme signal.

**Tech Stack:** Vditor 3.11.x; Preact + @preact/signals; Vite; Vitest (state layer) + Playwright (editor behaviour).

## Global Constraints

- TypeScript `strict: true`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, no `any`, relative imports carry `.js`.
- No external CDN or network: Vditor's assets and the rendering fonts are entirely self-hosted, and at runtime there are no requests to unpkg, jsdelivr, or similar.
- Colors: the chrome uses `tokens.css`; the Lapis render theme's colors stand alone (in the `lapis` content theme CSS), never entering tokens.css and never coupling to the chrome. The chrome font stays Maple Mono; the Lapis fonts apply only to the render area.
- The save model is unchanged: editing sets `dirty` and synchronously writes a localStorage draft, with no automatic persistence; Ctrl/Cmd+S = `flushSave`; `setValue` (open/reload/conflict) must not trigger `editContent` and falsely mark dirty.
- The three design disciplines are unchanged (no rounded corners [code blocks and Lapis excepted], no shadows [overlays excepted], 1px hairline panel dividers already in place).
- Testing: Vitest is split into `web` (jsdom) and `server` (node); **per-project runs are authoritative** (the full suite is unreliable when run concurrently). Playwright runs against a real build. The known intermittent `VaultWatcher mtime grace period` timeout under the full suite — confirm by isolating and re-running, do not treat it as a regression.
- One commit per task, with a Conventional Commits prefix.

## File structure

| File | Responsibility | Action |
|---|---|---|
| `scripts/prepare-assets.mjs` | Copies `node_modules/vditor/dist` into `public/vditor/` | Create |
| `public/vditor/**` | Self-hosted Vditor assets (gitignored) | Generated |
| `public/fonts/**` + `src/web/editor/fonts.css` | Self-hosted Lapis rendering fonts + @font-face | Create |
| `src/web/editor/VditorEditor.tsx` | The Vditor instance + wiring to document/theme | Create |
| `src/web/editor/lapis-theme.css` | Lapis content theme (light + dark) | Create |
| `src/web/theme/useTheme.ts` | Add the `resolvedTheme` signal | Modify |
| `src/web/components/SettingsModal.tsx` | Add the "Render theme" row (Lapis only) | Modify |
| `src/web/App.tsx` | `<Editor/>` → `<VditorEditor/>` | Modify |
| `src/web/editor/Editor.tsx`, `setup.ts`, `editor.css` | The old CM editor | Delete |
| `package.json` | +`vditor`, −`@codemirror/*`; add prepare-assets to build/dev | Modify |
| `vite.config.ts` | Confirm `public/` is treated as static assets (it is by default) | As needed |

---

### Task 1: Install Vditor + self-host its assets (build pipeline)

**Files:**
- Modify: `package.json` (+the `vditor` dep; a `prepare-assets` script hooked into `predev`/`prebuild`)
- Create: `scripts/prepare-assets.mjs`
- Modify: `.gitignore` (+`public/vditor/`)
- Test: `tests/server/prepare-assets.test.ts` (node environment, verifying the script's output)

**Interfaces:**
- Produces: a `public/vditor/` directory containing Vditor's dist (for `cdn:'/vditor'`); at runtime the frontend loads from `/vditor`.

- [ ] **Step 1: Install vditor**

```bash
pnpm add vditor
```

- [ ] **Step 2: Write the copy script `scripts/prepare-assets.mjs`**

At runtime Vditor lazily loads `dist/js/lute/lute.min.js`, `dist/js/icons/*`, `dist/css/content-theme/*`, code themes, and more from the `cdn` base path. The safest approach is to self-host the whole `dist`.

```js
import { cp, mkdir, rm, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'node_modules/vditor/dist')
const dest = resolve(root, 'public/vditor')

await access(src) // throws with a clear message if vditor is not installed
await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })
await cp(src, dest, { recursive: true })
console.log(`copied vditor dist -> public/vditor`)
```

- [ ] **Step 3: Hook it into the npm scripts**

Add to `package.json` scripts:
```json
"prepare-assets": "node scripts/prepare-assets.mjs",
"predev:web": "node scripts/prepare-assets.mjs",
"prebuild": "node scripts/prepare-assets.mjs"
```
(`prebuild` runs automatically before the existing `build`; `predev:web` runs before `dev:web`.)

- [ ] **Step 4: Add `public/vditor/` to `.gitignore`**

Generated output does not go into version control.

- [ ] **Step 5: Write the failing test**

`tests/server/prepare-assets.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../..')

describe('prepare-assets', () => {
  it('copies vditor lute wasm/js into public/vditor', async () => {
    execFileSync('node', ['scripts/prepare-assets.mjs'], { cwd: root })
    // the lute engine is the core of IR rendering and must be present
    await expect(access(path.join(root, 'public/vditor/dist/js/lute/lute.min.js'))).resolves.toBeUndefined()
  })
})
```
(If the lute path inside vditor's dist differs, run `ls node_modules/vditor/dist/js/lute/` first to confirm the real filename before writing the assertion.)

- [ ] **Step 6: Run, confirm it fails → create the script → confirm it passes**

Run: `pnpm vitest run tests/server/prepare-assets.test.ts`
It fails first (missing script / missing output), and passes once the script is in place.

- [ ] **Step 7: Confirm the build output contains vditor**

Run: `pnpm build`, then `ls dist/web/vditor/dist/js/lute/` (vite copies `public/` into `dist/web`). Confirm it is there.

- [ ] **Step 8: Commit**

```bash
git add package.json scripts/prepare-assets.mjs .gitignore tests/server/prepare-assets.test.ts pnpm-lock.yaml
git commit -m "build: self-host vditor dist assets under public/vditor"
```

---

### Task 2: The VditorEditor component + wiring to document, replacing CM and dropping the CM dependency

**Files:**
- Create: `src/web/editor/VditorEditor.tsx`
- Modify: `src/web/App.tsx` (swap Editor for VditorEditor)
- Delete: `src/web/editor/Editor.tsx`, `src/web/editor/setup.ts`, `src/web/editor/editor.css`
- Modify: `package.json` (remove the `@codemirror/*` dependencies)
- Test: `tests/web/vditor-editor.test.tsx` (shallow smoke); deeper Playwright coverage is Task 6

**Interfaces:**
- Consumes: `content`/`editContent`/`flushSave`/`dirty` (document.ts), `currentPath` (vault.ts), the self-hosted `/vditor` assets (Task 1)
- Produces: `export function VditorEditor(): VNode`

- [ ] **Step 1: Confirm whether Vditor can be instantiated in jsdom**

Probe first: `new Vditor` may fail in jsdom over contenteditable/wasm. Write a minimal mount test and run it once; if it throws, downgrade this component's unit test to the "imports without error + prop types" level, leave deep behaviour to Playwright (Task 6), and say so in the report. This step determines how deep the Step 2 test can go.

- [ ] **Step 2: Write the smoke test**

`tests/web/vditor-editor.test.tsx` (assertion depth per the Step 1 conclusion; below is the "can mount" version — switch to an import smoke test if jsdom cannot support it):

```tsx
import { render } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { VditorEditor } from '../../src/web/editor/VditorEditor.js'

describe('VditorEditor', () => {
  it('mounts an editor container', () => {
    const { container } = render(<VditorEditor />)
    expect(container.querySelector('.ink-editor')).toBeTruthy()
  })
})
```

- [ ] **Step 3: Implement VditorEditor.tsx**

```tsx
import { useEffect, useRef } from 'preact/hooks'
import Vditor from 'vditor'
import 'vditor/dist/index.css'
import { content, dirty, editContent, flushSave } from '../state/document.js'
import { currentPath } from '../state/vault.js'
// NOTE: do NOT import './fonts.css' or './lapis-theme.css' here — those files
// are created in Task 3 and Task 4, which each add their own import line to this
// file. Importing them now (before they exist) breaks the Task 2 build.

export function VditorEditor() {
  const hostRef = useRef<HTMLDivElement>(null)
  const vditorRef = useRef<Vditor | null>(null)
  const readyRef = useRef(false)
  const settingRef = useRef(false) // when true, the input callback does not feed back into editContent
  const lastPathRef = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (!hostRef.current) return
    const vd = new Vditor(hostRef.current, {
      mode: 'ir',
      cdn: '/vditor',
      preview: { cdn: '/vditor', theme: { current: 'lapis', path: '/vditor/dist/css/content-theme' } },
      toolbar: [],
      cache: { enable: false },
      input(value: string) {
        if (settingRef.current) return
        editContent(value)
      },
      keydown(e: KeyboardEvent) {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          void flushSave()
        }
      },
      after() {
        readyRef.current = true
        settingRef.current = true
        vd.setValue(content.value)
        settingRef.current = false
        lastPathRef.current = currentPath.value
      },
    })
    vditorRef.current = vd
    return () => {
      try { vd.destroy() } catch { /* tolerate jsdom/teardown errors */ }
      vditorRef.current = null
      readyRef.current = false
    }
  }, [])

  // Push in when content changes wholesale (open a file / external reload / take the disk version),
  // as opposed to user input.
  useEffect(() => {
    const vd = vditorRef.current
    if (!vd || !readyRef.current) return
    const next = content.value
    if (vd.getValue() === next) { lastPathRef.current = currentPath.value; return } // user input is already in vditor
    settingRef.current = true
    vd.setValue(next, true) // clearStack: rebuild the undo stack
    settingRef.current = false
    lastPathRef.current = currentPath.value
  }, [content.value, currentPath.value])

  return <div class="ink-editor" ref={hostRef} />
}
```
Note: `preview.theme.path` points at the self-hosted content-theme directory; if that option's name or shape does not match the installed version, check vditor's `IPreviewTheme` type definition and adjust (keeping `cdn:'/vditor'` unchanged, no external). The `settingRef` guard prevents `setValue`'s `input` from feeding back and falsely marking dirty (safe even if Vditor does emit input for setValue).

- [ ] **Step 4: Swap the editor in App.tsx**

In `src/web/App.tsx`: replace `import { Editor } from './editor/Editor.js'` + `import './editor/editor.css'` with `import { VditorEditor } from './editor/VditorEditor.js'`; in the center column, `<Editor />` → `<VditorEditor />`.

- [ ] **Step 5: Delete the CM files + remove the dependencies**

Delete `src/web/editor/Editor.tsx`, `setup.ts`, `editor.css`. Run `pnpm remove @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/lang-markdown` (go by what package.json actually lists under `@codemirror/*`; run `grep '@codemirror' package.json` first). Delete or migrate any test file that only tests CM (grep for `@codemirror`/`createState`/`EditorView` in tests/); state tests such as `document.ts` stay untouched.

- [ ] **Step 6: Run + typecheck + build**

Run: `pnpm vitest run --project web` (smoke passes; the CM tests are gone), `pnpm vitest run --project server`, `pnpm typecheck`, `pnpm exec vite build`.
Expected: green; the build succeeds; `grep -r '@codemirror' src/` returns nothing.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(editor): replace CodeMirror with Vditor IR, wire to manual-save model, drop CM"
```

---

### Task 3: Self-host the Lapis rendering fonts

**Files:**
- Create: `public/fonts/**` (the font files), `src/web/editor/fonts.css` (@font-face)
- Test: no dedicated unit test (fonts are static assets; Task 6's e2e covers rendering indirectly)

**Interfaces:**
- Consumes: nothing
- Produces: `@font-face` definitions for `"Cantarell"`, `"Source Han Serif CN"`, and `"JetBrains Mono"`, served from `/fonts`. **This task adds a `import './fonts.css'` line at the top of `VditorEditor.tsx`** (Task 2 deliberately did not import it; it is added here).

- [ ] **Step 1: Obtain the font files (OFL, self-hostable)**

All three are SIL OFL and redistributable. Put them in `public/fonts/` (committed — self-hosting must work offline). Prefer woff2 (size). Sources (download ttf/woff2):
- JetBrains Mono: already installed locally (`~/Library/Fonts/JetBrainsMono-Regular.ttf`), or `https://github.com/JetBrains/JetBrainsMono/releases` (take the woff2 from the webfonts).
- Cantarell: `https://github.com/googlefonts/cantarell-fonts/releases` (or the woff2 from Google Fonts).
- Source Han Serif CN: `https://github.com/adobe-fonts/source-han-serif/releases` (take the CN Regular/Bold subset; it is large, so take Regular + Bold woff2).
Place them as `public/fonts/cantarell-regular.woff2`, `source-han-serif-cn-regular.woff2` (+bold), `jetbrains-mono-regular.woff2` (+bold). Filenames follow whatever is actually downloaded, referenced correspondingly in fonts.css.

- [ ] **Step 2: Write `src/web/editor/fonts.css`**

```css
@font-face { font-family: "Cantarell"; src: url("/fonts/cantarell-regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "Cantarell"; src: url("/fonts/cantarell-bold.woff2") format("woff2"); font-weight: 700; font-display: swap; }
@font-face { font-family: "Source Han Serif CN"; src: url("/fonts/source-han-serif-cn-regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "Source Han Serif CN"; src: url("/fonts/source-han-serif-cn-bold.woff2") format("woff2"); font-weight: 700; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("/fonts/jetbrains-mono-regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("/fonts/jetbrains-mono-bold.woff2") format("woff2"); font-weight: 700; font-display: swap; }
```
(Omit a block when that weight's file is missing; at minimum each Regular is required.)

- [ ] **Step 3: Confirm the fonts reach the build output**

Run: `pnpm build`, then `ls dist/web/fonts/`. Vite copies `public/fonts` into `dist/web/fonts`. Confirm the woff2 files are there.

- [ ] **Step 4: Commit**

```bash
git add public/fonts src/web/editor/fonts.css
git commit -m "feat(editor): self-host Lapis render fonts (Cantarell, Source Han Serif, JetBrains Mono)"
```

---

### Task 4: Lapis content theme (light + dark)

**Files:**
- Create: `src/web/editor/lapis-theme.css` (containing both a `lapis` light section and a `lapis-dark` dark section)
- Modify: if the Vditor content theme has to live in its directory convention, the CSS may also be copied into `public/vditor/dist/css/content-theme/lapis.css` (Step 1 decides the injection method)
- Test: verified by Task 6's e2e (h2 pill background, blue headings, centered h1)

**Interfaces:**
- Consumes: the rendering fonts (Task 3), Vditor's IR DOM (`.vditor-ir` / `.vditor-reset`)
- Produces: the `lapis` / `lapis-dark` content theme applied to the render area

- [ ] **Step 1: Decide the injection method**

Two options: (a) as ordinary CSS, adding `import './lapis-theme.css'` at the top of `VditorEditor.tsx` (Task 2 deliberately did not import it; this task adds it), with selectors covering Vditor's IR DOM; or (b) registered as a Vditor content theme (`preview.theme.list`). **Use (a)** — more controllable, guarantees the override, and does not depend on Vditor's content-theme loading mechanism; `preview.theme.current` is still set to `lapis` to keep the naming aligned, but the actual styling comes from our CSS. Confirm the root class of the IR render DOM (after mounting, `document.querySelector('.vditor-ir')` / `.vditor-reset`) and anchor the selectors there.

- [ ] **Step 2: Capture the exact Lapis values**

The light values are already in the spec's table (captured from the repository's `lapis.css`). For dark: fetch `https://raw.githubusercontent.com/YiNNx/typora-theme-lapis/main/lapis-dark.css` and take the dark variables (dark background / light text / blue accent), writing `lapis-dark` with the same structure. Do not invent dark values.

- [ ] **Step 3: Write `lapis-theme.css`**

Scoped to Vditor's IR render root (the example below uses `.vditor-reset` as the root; adjust after measuring), reproducing Lapis. The light essentials (dark goes in a `:root[data-theme="dark"] .vditor-reset { ... }` section using the captured dark values):

```css
.vditor-reset {
  --lapis-accent: #4870ac;
  --lapis-text: #40464f;
  --lapis-block-bg: #f6f8fa;
  --lapis-marker: #a2b6d4;
  color: var(--lapis-text);
  font-family: "Cantarell", "Source Han Serif CN", "Songti SC", serif;
  font-size: 1.1rem;
  line-height: 1.6;
  max-width: 950px;
  margin: 0 auto;
}
.vditor-reset h1 { font-size: 2rem; color: var(--lapis-accent); text-align: center; margin: 0.9rem 0 2.3rem; }
.vditor-reset h2 { font-size: 1.5rem; color: #fff; background: var(--lapis-accent); padding: 1px 12.5px; border-radius: 4px; display: inline-block; margin: 0.3em 0; }
.vditor-reset h3 { font-size: 1.4rem; color: var(--lapis-accent); }
.vditor-reset h4 { font-size: 1.2rem; color: var(--lapis-accent); font-weight: normal; }
.vditor-reset h5, .vditor-reset h6 { font-size: 1.1rem; color: var(--lapis-accent); font-weight: normal; }
.vditor-reset blockquote { border-left: 3px solid var(--lapis-accent); background: var(--lapis-block-bg); padding: 15px 30px 15px 20px; font-size: 0.9em; margin: 20px 0; }
.vditor-reset code:not(.hljs) { background: var(--lapis-block-bg); color: var(--lapis-accent); font-family: "JetBrains Mono", monospace; font-size: 94%; padding: 2px 4px; border-radius: 3px; }
.vditor-reset pre, .vditor-reset .vditor-ir__marker--pre { background: var(--lapis-block-bg); border-radius: 10px; }
.vditor-reset pre code { color: #4f5467; font-family: "JetBrains Mono", monospace; }
.vditor-reset ul, .vditor-reset ol { padding-left: 20px; }
.vditor-reset li::marker { color: var(--lapis-marker); font-weight: bold; }
.vditor-reset table td, .vditor-reset table th { border: 1px solid #d9dfe4; padding: 5px 10px; }
.vditor-reset table th { color: var(--lapis-accent); font-weight: bold; text-align: center; }
.vditor-reset hr { border: none; border-top: 2px solid #eef2f5; margin: 20px 0; }
```
In practice Vditor IR's DOM class names may differ from `.vditor-reset` (IR uses `.vditor-ir`); Step 1 already requires confirming the root class, and the selector root goes by what is actually measured. The `display:inline-block` on h2 makes the "pill" hug the text width.

- [ ] **Step 4: Manual check (dev)**

`pnpm dev:web` + `pnpm dev:server` (or build and start the server), open a note containing `# heading / ## subheading / > quote / \`code\` / a list`, and confirm Lapis by eye: centered blue h1, blue h2 pill, blue-edged light-background quote, light-background rounded code. Keep a screenshot for the record.

- [ ] **Step 5: Commit**

```bash
git add src/web/editor/lapis-theme.css
git commit -m "feat(editor): replicate Lapis theme (light+dark) for Vditor IR render"
```

---

### Task 5: Settings-driven light/dark + the "Render theme" row

**Files:**
- Modify: `src/web/theme/useTheme.ts` (add the `resolvedTheme` signal)
- Modify: `src/web/editor/VditorEditor.tsx` (subscribe to `resolvedTheme` → `setTheme`)
- Modify: `src/web/components/SettingsModal.tsx` (add the "Render theme" row, Lapis only)
- Test: `tests/web/theme.test.ts` (append resolvedTheme assertions); Task 6's e2e verifies render-theme switching

**Interfaces:**
- Consumes: `applyThemeChoice` (existing), the Vditor instance's `setTheme(theme, contentTheme)`
- Produces: `export const resolvedTheme: Signal<'light' | 'dark'>` (useTheme.ts); on change, VditorEditor calls `setTheme`

- [ ] **Step 1: Write the failing test**

Append to `tests/web/theme.test.ts` (without changing what is there):

```ts
describe('the resolvedTheme signal', () => {
  it('resolvedTheme=dark after applyThemeChoice(dark)', () => {
    applyThemeChoice('dark')
    expect(resolvedTheme.value).toBe('dark')
  })
  it('resolvedTheme=light after applyThemeChoice(light)', () => {
    applyThemeChoice('light')
    expect(resolvedTheme.value).toBe('light')
  })
})
```
(Import `resolvedTheme` at the top.)

- [ ] **Step 2: Add resolvedTheme to useTheme.ts**

At the top of the file add `import { signal } from '@preact/signals'` and export `export const resolvedTheme = signal<'light' | 'dark'>(resolve(readThemeChoice()))`. Inside `applyThemeChoice`, after `document.documentElement.setAttribute('data-theme', resolve(choice))`, add `resolvedTheme.value = resolve(choice)`; also update `resolvedTheme.value = resolve('system')` inside the `systemListener` callback (on OS change).

- [ ] **Step 3: Subscribe from VditorEditor**

Add an effect in `VditorEditor.tsx`: read `resolvedTheme.value` and, once vditor is ready, call `vd.setTheme(resolvedTheme.value === 'dark' ? 'dark' : 'classic', resolvedTheme.value === 'dark' ? 'lapis-dark' : 'lapis')`. Because our Lapis styles key off `:root[data-theme="dark"]`, the content theme name is mostly for alignment; the editor theme (classic/dark) controls the lightness of Vditor's own UI. Effect deps `[resolvedTheme.value]`. Set it once in `after()` as well.

- [ ] **Step 4: Add the "Render theme" row to SettingsModal**

Near the font-size rows in the settings modal, add a "Render theme" row with a `<select aria-label="Render theme">` containing only `<option value="lapis">Lapis</option>` (selected by default; disabled or single-option). Only Lapis for now, with the structure reserved. No extra state is needed (single option). A comment can note the future extension. A read-only "Lapis" text would be the more minimal rendering — but a select matches the expectation that this is selectable, so use the select.

- [ ] **Step 5: Run + typecheck + build**

Run: `pnpm vitest run --project web` (the new theme cases pass), `pnpm typecheck`, `pnpm exec vite build`.

- [ ] **Step 6: Commit**

```bash
git add src/web/theme/useTheme.ts src/web/editor/VditorEditor.tsx src/web/components/SettingsModal.tsx tests/web/theme.test.ts
git commit -m "feat(editor): drive Vditor light/dark from settings; add render-theme row"
```

---

### Task 6: Playwright e2e — Lapis rendering / saving / theme / no CDN

**Files:**
- Modify: `tests/e2e/smoke.spec.ts` (append the Phase 1 cases), `tests/e2e/server.mjs` (seed a file with rich markdown, if the existing seed is not enough)
- Test: Playwright

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Seed a rich markdown file**

Confirm or extend the seed in `tests/e2e/server.mjs` with a `notes/rich.md` containing `# H1`, `## H2`, `> quote`, `` `code` ``, a fenced code block, and a list, to assert rendering against.

- [ ] **Step 2: Write the e2e cases**

Append to `tests/e2e/smoke.spec.ts` (reusing the existing login helper):

```ts
test('Vditor IR renders Lapis: blue-background h2 pill + blue headings', async ({ page }) => {
  await login(page)
  await page.getByRole('treeitem').filter({ hasText: 'notes' }).first().click()
  await page.getByRole('treeitem').filter({ hasText: 'rich.md' }).first().click()
  // Vditor IR renders real h1/h2 elements
  const h2 = page.locator('.vditor-ir h2, .vditor-reset h2').first()
  await expect(h2).toBeVisible()
  const bg = await h2.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).toBe('rgb(72, 112, 172)') // the #4870ac pill background
  const h1color = await page.locator('.vditor-ir h1, .vditor-reset h1').first().evaluate((el) => getComputedStyle(el).color)
  expect(h1color).toBe('rgb(72, 112, 172)')
})

test('manual save: the dot appears on edit and disappears on Ctrl+S', async ({ page }) => {
  await login(page)
  await page.getByRole('treeitem').filter({ hasText: 'notes' }).first().click()
  await page.getByRole('treeitem').filter({ hasText: 'rich.md' }).first().click()
  await page.locator('.vditor-ir, .vditor-reset').first().click()
  await page.keyboard.type('edit')
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
})

test('no external CDN requests (all assets self-hosted)', async ({ page }) => {
  const external: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') external.push(r.url())
  })
  await login(page)
  await page.getByRole('treeitem').filter({ hasText: 'notes' }).first().click()
  await page.getByRole('treeitem').filter({ hasText: 'rich.md' }).first().click()
  await page.waitForTimeout(1000)
  expect(external).toEqual([])
})
```
(Login and file-selection selectors follow the existing e2e helpers; inline the login steps if there is no `login` helper. `ControlOrMeta+s` is cross-platform. The h2 background assertion uses the rgb form of #4870ac.)

- [ ] **Step 3: Theme-switch e2e (optional but recommended)**

Append: open settings, switch to "Dark", and assert `document.documentElement` has `data-theme=dark` and that some element in the render area changes color to match dark Lapis.

- [ ] **Step 4: Run the e2e suite**

Run: `pnpm build && pnpm exec playwright test`
Expected: all green. If chromium is not installed, `pnpm exec playwright install chromium`; if the environment cannot install it, the report must say "e2e written but not verified" — do not fabricate.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e
git commit -m "test(e2e): Vditor IR Lapis render, manual-save dot, no external CDN"
```

---

## Completion criteria

- [ ] `pnpm vitest run --project web` and `--project server` are both green (state-layer tests unchanged; editor behaviour is covered by e2e)
- [ ] `pnpm typecheck` reports no errors; `grep -r '@codemirror' src/` returns nothing
- [ ] `pnpm build` succeeds; `dist/web/vditor/` and `dist/web/fonts/` exist
- [ ] `pnpm exec playwright test` is all green: IR renders Lapis (the #4870ac h2 pill, blue headings), edit → dot, Ctrl+S → dot disappears, no external CDN requests
- [ ] Manual check: opening a note shows Typora-style live IR rendering with the Lapis look; switching light/dark changes the rendering; create/rename/delete/commit/push (Phase 0.5) still work
