# Inkstone Phase 0.5 Design

On top of Phase 0 (a usable server-hosted markdown editor), fill in the pieces daily use is missing: UI for file-tree create/rename/delete, manual git commit/push, a settings modal, top/status bar visual polish, and switching the save model from autosave to manual save.

Phase 0.5 does not touch live preview (that is Phase 1).

## Background and existing constraints

- The backend `VaultGit` already has `commitAll/diffOfCommit/revertCommit/status/isRepo`, with errors uniformly wrapped in `VaultGitError` (messages contain no absolute server paths, with `cause` attached), and `commitAll` already guards against mid-revert.
- The backend already has `POST /api/logout` (clears the cookie), file CRUD routes (create/rename/delete, with a per-path write lock), `markSelfWrite` self-write suppression, and `autoCommit` (an idle-aware commit every 5 minutes).
- The frontend api client already has `createEntry/rename/remove/login`; `document.ts` has debounced autosave + localStorage drafts + conflict handling; `vault.ts` has `tree/currentPath/expandedDirs/refreshTree/treeError`; the theme layer uses CSS variables + localStorage + `data-theme`.
- The three design disciplines are unchanged: no rounded corners (except 3px on code blocks), no shadows (except overlays), no borders as separators (rely on background contrast). Colors live only in `tokens.css`.
- Known intermittent: two backend tests (watcher mtime, ws-auth) occasionally time out under full-suite concurrency and always pass in isolation — not a regression.

## Settled decisions

| Decision | Choice |
|---|---|
| Save model | Drop autosave; manual Ctrl/Cmd+S |
| Unsaved marker | A small SVG dot (not text), in two places: the dirty file's row in the tree, and the top-bar breadcrumb |
| localStorage drafts | Keep (written synchronously on every keystroke, as a crash / accidental-close fallback); cleared after a successful Ctrl+S |
| Unsaved-work protection | Native `beforeunload` warning on tab close/refresh; no interception on file switch (drafts restore it) |
| Existing save text in the top bar | Remove the "Saved / Unsaved / Saving" text; keep only the red save-failure text |
| Settings modal form | A single centered panel (codex/claude row style, no left nav) |
| Settings contents | Appearance (theme: system/light/dark, three icons), editor font size (adjustable, default 16), tree font size (adjustable, default 14), vault info + log out |
| Commit interaction | One click, with an automatic message `manual: <timestamp>` |
| Push interaction | Confirm first (showing which remote/branch it will push to plus the commit count) |
| Top/status bar | Direction B: top 48px / bottom 32px, 18px SVG icons, 16px spacing |
| Icons | Line SVGs replacing the unicode glyphs (`☰ ☾ ▤`); gear = settings |

## 1. New backend git capabilities

### 1.1 New `VaultGit` methods

```ts
interface RemoteInfo { name: string; branch: string; ahead: number }

// Returns null when there is no upstream (does not throw). ahead = git rev-list --count @{u}..HEAD
remoteInfo(): Promise<RemoteInfo | null>

// Pushes the current branch to its upstream, never force. Wraps three failure classes as VaultGitError:
//   'no upstream configured' / 'not fast-forward, pull first' / 'authentication failed'
// On success returns the ahead count from before the push.
push(): Promise<{ pushed: number }>
```

`remoteInfo`: first `git remote` (empty → return null); then look up the current branch's upstream `@{u}`, returning null when there is none; otherwise `git rev-list --count @{u}..HEAD` for the ahead count. All of it wrapped by `guardGit`.

`push`: `git push` (no `--force`, no refspec, relying on the configured upstream). On failure, classify by reading stderr: contains `no upstream` / no upstream → an explicit message; contains `non-fast-forward` / `rejected` → "the remote has new commits, pull first"; contains `Authentication` / `could not read` / `Permission` → "authentication failed"; otherwise → a generic "push failed". No message contains an absolute path, and the original error goes in `cause`.

Manual commit reuses `commitAll(message)`; no new git method.

### 1.2 Routes (all top-level app + existing auth)

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/git/commit` | `{ message?: string }` | `{ sha, files } \| null` (no changes) |
| POST | `/api/git/push` | — | `{ pushed } \| 4xx + {error}` |
| GET | `/api/git/status` | — | `{ dirty, branch, hasRemote, ahead }` (extended) |

`/api/git/commit`: the frontend composes `manual: <local timestamp>` and passes it as `message` (the server does not depend on a clock, which keeps it testable); the server calls `commitAll(message)`. Mid-revert already makes `commitAll` throw `VaultGitError` → falls back to a safe error.
`/api/git/status`: merge `remoteInfo()` into the existing `{dirty,branch}` — `hasRemote = remoteInfo !== null`, `ahead = remoteInfo?.ahead ?? 0`.
Push failure status codes: non-fast-forward / no upstream → 409, authentication → 502, otherwise → 500; body `{error}` carries the safe message.

## 2. File-tree operations UI

Add a toolbar row to the `FileTree` header: two line-SVG icon buttons, **New document** and **New folder**. The target directory is the currently selected directory (if a file is selected, its parent); with no selection, the vault root.

On hover, each `TreeNode` row floats two small icons on the right, **Rename** and **Delete** (taking up no visual weight when not hovered).

Interaction:
- **Create**: insert a temporary row with an editable name (an input) in place under the target directory. Enter → call `api.createEntry(path, kind)`, then `refreshTree()` on success; for the document type, `openFile(path)` afterwards. Esc cancels. An empty or duplicate name → inline red text, no submit.
- **Rename**: the filename in the row becomes an input, prefilled with the current name. Enter → `api.rename(from, to)` + `refreshTree()`; if the renamed file is the one currently open, update `currentPath`. Esc cancels.
- **Delete**: a light inline confirmation — the right side of the row becomes "Delete? ✓ ✗" (no modal). ✓ → `api.remove(path)` + `refreshTree()`; if the deleted file is the one currently open, clear the editor and `currentPath`.
- Any failure reuses the `treeError` signal, shown as red text at the top of the file tree.

State: a new `pendingOp` signal in `vault.ts` (`{ kind:'create-file'|'create-dir'|'rename', parentOrPath, initialName } | null`) drives the in-place input row; delete confirmation uses local state inside `TreeNode`.

## 3. Settings modal + font size system

### 3.1 Font size system

`tokens.css` already has `--ink-font-size: 16px` (used by the editor). Add `--ink-tree-font-size` (default 14px; `filetree.css` changes from a hard-coded 13px to referencing it). Both work like the theme: stored in localStorage (`inkstone.editorFontSize` / `inkstone.treeFontSize`), read at startup (in `main.tsx` initialization, separate from the `index.html` pre-paint script) and applied with `document.documentElement.style.setProperty`.

Add `src/web/state/settings.ts`:
```ts
export const editorFontSize: Signal<number>  // 14 | 16 | 18, default 16
export const treeFontSize: Signal<number>    // 13 | 14 | 16, default 14
export function setEditorFontSize(px: number): void  // writes the signal + CSS variable + localStorage
export function setTreeFontSize(px: number): void
export function initSettings(): void          // applies stored values at startup
```
Reads use the same `safeGetItem`/`safeSetItem` as the theme (fall back to the default when storage is denied, never crash).

### 3.2 The modal

The top bar's gear button opens `SettingsModal` (`src/web/components/SettingsModal.tsx`). Single centered panel, `role="dialog"`, a backdrop plus the modal (an overlay, so shadows are allowed). Esc or a backdrop click closes it. Row layout, each row being "label + control on the right":

| Row | Control |
|---|---|
| Appearance | Three-icon toggle: system / light / dark (reuses Task 9's OS-preference logic; the theme control moves here from the top bar) |
| Editor font size | `<select>` 14 / 16 / 18px |
| Tree font size | `<select>` 13 / 14 / 16px |
| Vault | Read-only text showing `VAULT_ROOT` (served via `/api/git/status` or a new read-only endpoint; see below) |
| Remote | Read-only, `origin ✓` / `no remote` (from `hasRemote` in `/api/git/status`) |
| | Log out button → `POST /api/logout`, then back to the login page |

The vault path: add a separate read-only endpoint `GET /api/vault/info` → `{ root: string }` (root is the configured vault path — this is the one place we **deliberately** return a server path to the client, because it is information the user configured themselves and wants displayed, not an error leak). It is not merged into status, which stays confined to git state.

The theme's three states (system/light/dark) require extending Task 9's two states (light/dark + an OS fallback on first visit) into explicit three-state storage: `inkstone.theme` holds `'system'|'light'|'dark'`; under `'system'` it follows `matchMedia` and listens for changes. The top bar's `☾` quick-toggle is removed (the theme lives only in settings).

## 4. Commit / push buttons

Placed on the right of the **bottom status bar** (after the git indicator):

```
128 words · 512 chars                    main ●   [Commit]   [↑ Push 3]
```

- **Commit**: a light text button. Disabled and greyed out when the working tree is clean (`!dirty` and git reports no changes). Click → the frontend composes `manual: <timestamp>` → `POST /api/git/commit` → refresh git status.
- **Push**: appears only when `hasRemote` is true, with the `ahead` count in the label (`↑ Push 3`); greyed out when `ahead === 0`. Click → **confirm first** ("Push 3 commits to origin/main?", a lightweight inline confirmation or small modal) → on confirmation `POST /api/git/push`, a spinner while pushing, and the result reported in the status bar (`ahead` returns to zero on success; red text on failure, with the message coming from the backend's safe error).
- All of them light text/icon buttons, with no heavy borders and no shadows.

Refreshing git status: besides the initial load, actively re-fetch `/api/git/status` after a commit or push. (Note: Phase 0's `git-status` WS event is dead code — the backend never broadcasts it. Phase 0.5 wires it up along the way with `AutoCommit.onCommit → hub.broadcast({type:'git-status', ...})`, so the status bar also refreshes after an automatic commit. This doubles as a fix for A.1 from the Phase 0 final review.)

## 5. Top / status bar visual polish (direction B)

`tokens.css`: `--ink-topbar-height` 32→48px, `--ink-statusbar-height` 24→32px. The top/status bar `gap` and `padding` go to 16px, and the top bar's font size to 14px.

Icons: add `src/web/components/icons.tsx`, exporting line-SVG icon components (`stroke-width:1.8`, `currentColor`, 18×18): sidebar toggle, right-panel toggle, gear (settings), new document, new folder, rename, delete, unsaved dot, push arrow. These replace the top bar's `☰ ☾ ▤` unicode glyphs. Icons default to `--ink-fg-muted`, with a 28px hit area.

**Hover effects** (chosen after testing in the browser companion):
- **All icons**: `color` transitions `--ink-fg-muted → --ink-link` (0.16s ease), an understated color change.
- **The gear (settings) icon only**: additionally `transform: rotate(60deg)` (0.4s ease) — this suits a "mechanical" icon like a gear and nothing else; no other icon rotates.
- No variable fonts (that is what Claude's interface does with the Anthropicons proprietary variable weight axis); a CSS transition on an inline SVG is enough, with zero font dependency.

Final top bar layout: `[sidebar toggle] breadcrumb (with unsaved dot) ……spacer…… [gear settings] [right-panel toggle]`.
Final status bar layout: `word count · char count ……spacer…… git status [Commit] [Push]`.

The unsaved dot (§6) sits to the left of the filename in the breadcrumb, and to the left of the filename in the file-tree row.

## 6. Manual save model (replacing Phase 0 Task 12's autosave)

Changes to `document.ts`:
- `editContent(next)`: only `content.value=next`, `dirty.value=true`, and a synchronous draft write. **Remove the debounce timer** and the `performSave` it triggered. Correspondingly remove `cancelPendingSave`'s timer semantics (keep it as a no-op, or delete it and update the Editor's unmount logic).
- `flushSave()` (already bound to Ctrl+S): kept. Success → `dirty=false`, clear the draft, refresh git status; failure → keep `dirty` and the draft, and set `saveError` to the message.
- Remove the `saveState` signal in favour of two signals: `dirty` (memory vs disk, driving the dot) and `saveError: Signal<string | null>` (the save-failure message, cleared on success). In the steady state there is no text at all — the dot is the only unsaved signal.
- Save-state text is removed from the top bar; when `saveError` is non-null it is shown as red text on the right of the bottom status bar, without blocking editing.

The unsaved dot's data source is the `dirty` signal (memory vs disk). It means something different from git's `●` (disk vs committed), and the UI keeps them in separate places so they cannot be confused.

`beforeunload`: `App.tsx` registers a listener that calls `event.preventDefault()` when `dirty.value` is true, triggering the browser's native "Leave? Unsaved changes" warning. File switching is not intercepted (`openFile` behaviour is unchanged; drafts guarantee recovery).

**This supersedes Phase 0's commit `bc3e002`** (which added a textual "Unsaved" state); Phase 0.5 replaces it with the dot + manual save.

## 7. Error handling

| Scenario | Handling |
|---|---|
| Push with no upstream / non-fast-forward / auth failure | A `VaultGitError` each, with a safe message + `cause`; the route maps them to 409/409/502 |
| Commit during a mid-revert | `commitAll` already throws `VaultGitError` → falls back to a safe message |
| File create/rename/delete failure | `treeError` red text; a failed delete leaves the file in place |
| Save failure (disk full / permissions / 409 conflict) | Keep `dirty` + the draft; 409 goes through the existing conflict bar; anything else shows red text |
| Font size localStorage denied | Fall back to the default, never crash (safeGet/Set) |
| `/api/vault/info` deliberately echoes the vault path | The only intentional path echo; not an error leak |

## 8. Testing

| Target | Method |
|---|---|
| `VaultGit.remoteInfo/push` | A local temporary bare repo as the upstream (a real push, no network): one case each for upstream present / absent / ahead by N / non-fast-forward (commit on the remote first, then push); assert the error is a `VaultGitError` whose message contains no absolute path |
| git routes | commit (with changes / without changes / mid-revert), push (success / no upstream / non-fast-forward), the extended status fields |
| `/api/vault/info` | Returns the configured root |
| File-tree operations | New document/folder, rename, delete (including deleting the currently open file), failures setting `treeError`; the `pendingOp` in-place input row |
| Settings font sizes | `setEditorFontSize/setTreeFontSize` write the CSS variable + localStorage; `initSettings` applies stored values; a denied store falls back |
| Settings modal | Open/close (Esc, backdrop), three-state theme switching, log out calling logout |
| Manual save | Editing sets dirty without persisting (no timer); Ctrl+S persists and clears dirty; beforeunload fires while dirty |
| Unsaved dot | While dirty, the dot appears in the file-tree row and the breadcrumb, and disappears after saving |
| Commit/push buttons | Greyed out when clean; the push confirmation flow; the ahead count display |
| Playwright smoke | Add one: create file → rename → delete; and one: edit → dot appears → Ctrl+S → dot disappears |

## 9. Explicitly out of scope

Multi-remote selection, pull/fetch, merge conflict resolution, arrow-key navigation between settings rows, live preview (Phase 1), visual tables, mobile.
