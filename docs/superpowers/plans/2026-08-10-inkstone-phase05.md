# Inkstone Phase 0.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On top of Phase 0, fill in what daily use is missing: file-tree create/rename/delete UI, manual git commit/push, a settings modal (adjustable font sizes + a three-state theme), top/status bar visual polish, and switching the save model from autosave to manual Ctrl+S (with unsaved marked by an SVG dot).

**Architecture:** The backend adds `remoteInfo`/`push` to `VaultGit`, plus git routes and `/api/vault/info`; the frontend adds a `settings` state layer, an `icons.tsx` SVG icon set, and a `SettingsModal`, rewrites `document.ts`'s save model, polishes `TopBar`/`StatusBar`, and gives the file tree an operations UI. Every change follows the patterns and three design disciplines established in Phase 0.

**Tech Stack:** Node/TS + Fastify + simple-git (backend); Preact + @preact/signals + CodeMirror 6 (frontend); Vitest + Playwright (testing).

## Global Constraints

- TypeScript `strict: true`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, no `any`, relative imports carry `.js`.
- Every server module's errors must be a `VaultError`/`VaultPathError`/`VaultGitError`, with messages containing only the caller's input and **no absolute server paths**, and the original error attached as `cause`. The single deliberate exception: `GET /api/vault/info` echoes the configured vault path.
- Custom error classes extend Error, set `this.name`, and accept `ErrorOptions` forwarded to super.
- All routes and Fastify decorators/hooks attach to the **top-level app**; do not nest `app.register(async instance => ...)` (the only exception is the existing `/ws` via `app.after`).
- Signals trigger re-renders by **reassignment**, never by mutating in place.
- The three design disciplines: no rounded corners (except 3px on code blocks), no shadows (except overlays), no borders as separators (rely on background contrast). Colors live only in `src/web/theme/tokens.css`.
- Backend tests go in `tests/server/**/*.test.ts` (node environment), frontend tests in `tests/web/**/*.test.{ts,tsx}` (jsdom).
- One commit per task, with a Conventional Commits prefix.
- Known intermittent: the backend watcher mtime and ws-auth tests occasionally time out under full-suite concurrency, always pass in isolation, and go green on a re-run — not a regression, do not "fix" them.
- git upstream/push tests use a local temporary bare repo as the upstream, with a real push and no network.

---

### Task 1: VaultGit.remoteInfo + push

**Files:**
- Modify: `src/server/git/index.ts`
- Test: `tests/server/git/git.test.ts` (append; do not change the existing cases)

**Interfaces:**
- Consumes: the existing `VaultGit` (the `#git` simpleGit instance, the `guardGit` wrapper, `VaultGitError`)
- Produces:
```ts
export interface RemoteInfo { name: string; branch: string; ahead: number }
class VaultGit {
  remoteInfo(): Promise<RemoteInfo | null>   // no remote or no upstream → null
  push(): Promise<{ pushed: number }>        // pushes the current branch to its upstream, never force
}
```

- [ ] **Step 1: Write the failing test**

Append at the end of `tests/server/git/git.test.ts`. Reuse the `makeRepo`/temp-directory helper already at the top of the file (if there is none, use `fs.mkdtemp` + `simpleGit().init(['--initial-branch=main'])` + configure a user).

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'

async function makeRepoWithRemote() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ink-remote-'))
  const bare = path.join(base, 'bare.git')
  const work = path.join(base, 'work')
  await simpleGit().init(['--bare', bare])
  const g = simpleGit()
  await g.init([work, '--initial-branch=main'] as never).catch(async () => {
    await fs.mkdir(work, { recursive: true }); await simpleGit(work).init(['--initial-branch=main'])
  })
  const wg = simpleGit(work)
  await wg.addConfig('user.email', 't@e.com'); await wg.addConfig('user.name', 't')
  await fs.writeFile(path.join(work, 'a.md'), 'one\n')
  await wg.add('.'); await wg.commit('init')
  await wg.addRemote('origin', bare); await wg.push(['-u', 'origin', 'main'])
  return { base, bare, work }
}

describe('VaultGit.remoteInfo', () => {
  it('returns null when there is no remote', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ink-noremote-'))
    const g = simpleGit(dir); await g.init(['--initial-branch=main'])
    await g.addConfig('user.email', 't@e.com'); await g.addConfig('user.name', 't')
    await fs.writeFile(path.join(dir, 'a.md'), 'x'); await g.add('.'); await g.commit('c')
    expect(await new VaultGit(dir).remoteInfo()).toBeNull()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('ahead=0 when there is an upstream and nothing ahead', async () => {
    const { base, work } = await makeRepoWithRemote()
    const info = await new VaultGit(work).remoteInfo()
    expect(info).toEqual({ name: 'origin', branch: 'main', ahead: 0 })
    await fs.rm(base, { recursive: true, force: true })
  })

  it('ahead=N when the local branch is N commits ahead', async () => {
    const { base, work } = await makeRepoWithRemote()
    await fs.appendFile(path.join(work, 'a.md'), 'two\n')
    const wg = simpleGit(work); await wg.add('.'); await wg.commit('c2')
    expect((await new VaultGit(work).remoteInfo())?.ahead).toBe(1)
    await fs.rm(base, { recursive: true, force: true })
  })
})

describe('VaultGit.push', () => {
  it('pushes the commits it is ahead by and returns the count', async () => {
    const { base, bare, work } = await makeRepoWithRemote()
    await fs.appendFile(path.join(work, 'a.md'), 'two\n')
    const wg = simpleGit(work); await wg.add('.'); await wg.commit('c2')
    const res = await new VaultGit(work).push()
    expect(res.pushed).toBe(1)
    // the bare repo should now contain that commit
    expect((await simpleGit(bare).raw(['log', '--oneline'])).trim()).toContain('c2')
    await fs.rm(base, { recursive: true, force: true })
  })

  it('throws VaultGitError with no absolute path in the message when there is no upstream', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ink-noup-'))
    const g = simpleGit(dir); await g.init(['--initial-branch=main'])
    await g.addConfig('user.email', 't@e.com'); await g.addConfig('user.name', 't')
    await fs.writeFile(path.join(dir, 'a.md'), 'x'); await g.add('.'); await g.commit('c')
    let err: unknown
    try { await new VaultGit(dir).push() } catch (e) { err = e }
    expect(err).toBeInstanceOf(VaultGitError)
    expect((err as Error).message).not.toContain(dir)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('throws VaultGitError on a non-fast-forward', async () => {
    const { base, bare, work } = await makeRepoWithRemote()
    // a second clone pushes a commit, leaving work behind → committing in work is then non-fast-forward
    const work2 = path.join(base, 'work2')
    await simpleGit().clone(bare, work2)
    const w2 = simpleGit(work2); await w2.addConfig('user.email','t@e.com'); await w2.addConfig('user.name','t')
    await fs.appendFile(path.join(work2, 'a.md'), 'from2\n'); await w2.add('.'); await w2.commit('c2'); await w2.push()
    await fs.appendFile(path.join(work, 'a.md'), 'from1\n')
    const wg = simpleGit(work); await wg.add('.'); await wg.commit('c1-local')
    let err: unknown
    try { await new VaultGit(work).push() } catch (e) { err = e }
    expect(err).toBeInstanceOf(VaultGitError)
    await fs.rm(base, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/server/git/git.test.ts`
Expected: the new cases FAIL (`remoteInfo`/`push` undefined)

- [ ] **Step 3: Implement**

Add the interface and methods in `src/server/git/index.ts`. `guardGit` is the existing private wrapper (converting simple-git errors into `VaultGitError`); classifying `push` failures requires reading the raw stderr, so it cannot rely on `guardGit` alone and needs its own try/catch.

```ts
export interface RemoteInfo {
  name: string
  branch: string
  ahead: number
}
```

Inside the `VaultGit` class:

```ts
  async remoteInfo(): Promise<RemoteInfo | null> {
    return this.#guard(async () => {
      const remotes = await this.#git.getRemotes()
      if (remotes.length === 0) return null
      const status = await this.#git.status()
      const branch = status.current ?? 'HEAD'
      if (!status.tracking) return null // no upstream
      const name = status.tracking.split('/')[0] ?? remotes[0]!.name
      const raw = await this.#git.raw(['rev-list', '--count', '@{u}..HEAD'])
      return { name, branch, ahead: Number.parseInt(raw.trim(), 10) || 0 }
    })
  }

  async push(): Promise<{ pushed: number }> {
    const info = await this.remoteInfo()
    if (info === null) {
      throw new VaultGitError('no upstream configured for the current branch')
    }
    try {
      await this.#git.push()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/non-fast-forward|rejected|fetch first|behind/i.test(msg)) {
        throw new VaultGitError('remote has changes; pull before pushing', { cause: err })
      }
      if (/authenticat|permission|could not read|access denied/i.test(msg)) {
        throw new VaultGitError('authentication failed while pushing', { cause: err })
      }
      throw new VaultGitError('push failed', { cause: err })
    }
    return { pushed: info.ahead }
  }
```

Note: `this.#guard` is how the existing `guardGit` is invoked — open `git/index.ts` and confirm how the existing methods (such as `status`) wrap themselves, then copy that pattern (it may be `this.#guard(fn)` or a direct `guardGit(() => ...)`). If the existing form is a free function `guardGit`, write `remoteInfo` as `return guardGit(async () => {...})`.

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm vitest run tests/server/git/git.test.ts`
Expected: everything PASSes (including the pre-existing cases)

- [ ] **Step 5: Full backend suite**

Run: `pnpm vitest run --project server`
Expected: green (the watcher/ws flakes are allowed; a re-run goes green)

- [ ] **Step 6: Commit**

```bash
git add src/server/git/index.ts tests/server/git/git.test.ts
git commit -m "feat(git): add remoteInfo and push with classified failures"
```

---

### Task 2: git routes + /api/vault/info + extended status

**Files:**
- Modify: `src/server/routes/files.ts` (or wherever the git routes currently live — grep `/api/git/status` to locate it first)
- Modify: `src/server/app.ts` (if config.vaultRoot has to be injected for vault/info)
- Test: `tests/server/routes/files.test.ts` or `tests/server/routes/git.test.ts`

**Interfaces:**
- Consumes: `VaultGit.remoteInfo/push/commitAll` (Task 1 + existing); `Config.vaultRoot`; the `makeTestApp`/`login` test helpers
- Produces:
  - `POST /api/git/commit` body `{ message?: string }` → `{ sha, files } | null`
  - `POST /api/git/push` → `{ pushed } | 4xx {error}`
  - `GET /api/git/status` → `{ dirty, branch, hasRemote, ahead }`
  - `GET /api/vault/info` → `{ root }`

- [ ] **Step 1: Write the failing test**

Read `tests/server/helpers/app.ts` first to confirm what `makeTestApp` returns and how it creates the git repo. Then append:

```ts
describe('GET /api/git/status extended', () => {
  it('hasRemote=false, ahead=0 when there is no remote', async () => {
    const t = await makeTestApp(); const cookie = await login(t)
    const res = await t.app.inject({ method: 'GET', url: '/api/git/status', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ hasRemote: false, ahead: 0 })
    await t.cleanup()
  })
})

describe('POST /api/git/commit', () => {
  it('commits when there are changes and returns the sha', async () => {
    const t = await makeTestApp(); const cookie = await login(t)
    await t.app.inject({ method: 'PUT', url: '/api/file', headers: { cookie }, payload: { path: 'notes/a.md', content: 'changed\n' } })
    const res = await t.app.inject({ method: 'POST', url: '/api/git/commit', headers: { cookie }, payload: { message: 'manual: test' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().sha).toMatch(/^[0-9a-f]{40}$/)
    await t.cleanup()
  })
  it('returns null when there are no changes', async () => {
    const t = await makeTestApp(); const cookie = await login(t)
    const res = await t.app.inject({ method: 'POST', url: '/api/git/commit', headers: { cookie }, payload: { message: 'x' } })
    expect(res.statusCode).toBe(200); expect(res.json()).toBeNull()
    await t.cleanup()
  })
})

describe('POST /api/git/push', () => {
  it('409 with no path leaked when there is no upstream', async () => {
    const t = await makeTestApp(); const cookie = await login(t)
    const res = await t.app.inject({ method: 'POST', url: '/api/git/push', headers: { cookie } })
    expect(res.statusCode).toBe(409)
    expect(res.body).not.toContain(t.root)
    await t.cleanup()
  })
})

describe('GET /api/vault/info', () => {
  it('returns the configured root', async () => {
    const t = await makeTestApp(); const cookie = await login(t)
    const res = await t.app.inject({ method: 'GET', url: '/api/vault/info', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().root).toBe(t.root)
    await t.cleanup()
  })
  it('401 when unauthenticated', async () => {
    const t = await makeTestApp()
    expect((await t.app.inject({ method: 'GET', url: '/api/vault/info' })).statusCode).toBe(401)
    await t.cleanup()
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/server/routes/`
Expected: the new cases FAIL

- [ ] **Step 3: Implement the routes**

Add them in the same function that registers the file routes (top-level app, inside the existing `registerFileRoutes(app, deps)`). `deps` already carries `vault`/`git`/`config` (confirm whether `AppDeps` has `config`; if not, put `config` into the deps passed to the routes in `buildApp` in `app.ts`).

```ts
  app.post<{ Body: { message?: unknown } }>('/api/git/commit', async (req, reply) => {
    const message = typeof req.body?.message === 'string' && req.body.message.trim()
      ? req.body.message : 'manual commit'
    try {
      const result = await git.commitAll(message)
      return reply.send(result) // CommitResult | null
    } catch (err) {
      return sendGitError(reply, err)
    }
  })

  app.post('/api/git/push', async (_req, reply) => {
    try {
      return reply.send(await git.push())
    } catch (err) {
      return sendGitError(reply, err)
    }
  })

  app.get('/api/git/status', async (_req, reply) => {
    const status = await git.status()
    const info = await git.remoteInfo()
    return reply.send({ dirty: status.dirty, branch: status.branch, hasRemote: info !== null, ahead: info?.ahead ?? 0 })
  })

  app.get('/api/vault/info', async (_req, reply) => {
    return reply.send({ root: config.vaultRoot })
  })
```

Add a `sendGitError` (in the same file, alongside the existing `sendVaultError`):

```ts
function sendGitError(reply: FastifyReply, err: unknown) {
  if (err instanceof VaultGitError) {
    const m = err.message
    if (/no upstream|not fast-forward|remote has changes|pull before/i.test(m)) return reply.code(409).send({ error: m })
    if (/authenticat/i.test(m)) return reply.code(502).send({ error: m })
    return reply.code(500).send({ error: m })
  }
  throw err // let the global setErrorHandler catch it
}
```

If a `GET /api/git/status` already exists, replace it; `import { VaultGitError } from '../git/index.js'` and make sure `config` is available.

- [ ] **Step 4: Run, confirm it passes + full backend suite**

Run: `pnpm vitest run --project server`
Expected: green

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/ src/server/app.ts tests/server/routes/
git commit -m "feat(routes): add git commit/push routes, extend status, add vault info"
```

---

### Task 3: git-status WebSocket broadcast (fixes the Phase 0 A.1 dead code)

**Files:**
- Modify: `src/server/app.ts` or `src/server/main.ts` (wherever `AutoCommit`'s `onCommit` callback lives)
- Modify: `src/server/autocommit.ts` (if the `onCommit` signature needs it)
- Test: `tests/server/autocommit.test.ts` or `tests/server/ws.test.ts`

**Interfaces:**
- Consumes: `WsHub.broadcast(event)`, `ServerEvent` (including `git-status`), `VaultGit.status/remoteInfo`, `AutoCommit`'s `onCommit`
- Produces: after an automatic commit, the hub broadcasts `{ type: 'git-status', dirty, branch, hasRemote, ahead }`

- [ ] **Step 1: Confirm the shape of ServerEvent's git-status**

Read the `git-status` variant in `src/shared/events.ts`. The Phase 0 definition may be `{ type:'git-status'; dirty; branch }`. This task extends it to `{ type:'git-status'; dirty; branch; hasRemote; ahead }`, matching the status route. After changing `events.ts` the frontend consumer (App.tsx) must follow (Tasks 7/10 touch it; here we only guarantee type consistency).

- [ ] **Step 2: Write the failing test**

Append to `tests/server/autocommit.test.ts`: inject a fake `onCommit`/hub and assert that `AutoCommit` calls the broadcast after a successful commit. If the wiring lives in `main.ts` (hard to unit test), instead wire `onCommit` to `broadcastGitStatus` at the `buildApp`/`AppDeps` layer and test that function: given a git repo with a commit, calling it makes the hub receive a `git-status` event.

```ts
it('broadcasts git-status after an automatic commit', async () => {
  const events: unknown[] = []
  const hub = { broadcast: (e: unknown) => events.push(e), clientCount: 0, registerRoute() {} }
  // construct a real temporary git repo + VaultGit + AutoCommit, with onCommit calling broadcastGitStatus(git, hub)
  // trigger one commitNow and assert a { type:'git-status' } shows up in events
  // (reuse the existing temporary-repo helper in autocommit.test.ts for the construction)
  expect(events.some((e) => (e as { type?: string }).type === 'git-status')).toBe(true)
})
```

- [ ] **Step 3: Implement**

Define this in `buildApp` (or wherever main.ts assembles things):

```ts
async function broadcastGitStatus(git: VaultGit, hub: WsHub): Promise<void> {
  const status = await git.status()
  const info = await git.remoteInfo()
  hub.broadcast({ type: 'git-status', dirty: status.dirty, branch: status.branch, hasRemote: info !== null, ahead: info?.ahead ?? 0 })
}
```

Wire `AutoCommit`'s `onCommit` (currently a `console.error` placeholder from Phase 0) to `() => void broadcastGitStatus(git, hub)`. Task 2's commit/push routes should also broadcast once on success (optional — the frontend in Tasks 10/11 re-fetches anyway, but broadcasting is more immediate): add `void broadcastGitStatus(git, hub)` before those routes return.

- [ ] **Step 4: Run, confirm it passes + full backend**

Run: `pnpm vitest run --project server`
Expected: green

- [ ] **Step 5: Commit**

```bash
git add src/server tests/server
git commit -m "feat(ws): broadcast git-status after autocommit and manual git ops"
```

---

### Task 4: The settings state layer (font size system + three-state theme)

**Files:**
- Create: `src/web/state/settings.ts`
- Modify: `src/web/theme/tokens.css` (add `--ink-tree-font-size`), `src/web/theme/useTheme.ts` (two states → three), `src/web/filetree/filetree.css` (13px → reference the variable), `src/web/main.tsx` (startup initialization)
- Test: `tests/web/settings.test.ts`, `tests/web/theme.test.ts` (append three-state cases; do not change the existing ones)

**Interfaces:**
- Consumes: the existing `safeGetItem`/`safeSetItem` (in `useTheme.ts`; if they are private, export them or copy the same try/catch wrapper into settings.ts)
- Produces:
```ts
// settings.ts
export const editorFontSize: Signal<number>   // 14|16|18, default 16
export const treeFontSize: Signal<number>     // 13|14|16, default 14
export function setEditorFontSize(px: number): void
export function setTreeFontSize(px: number): void
export function initSettings(): void
// useTheme.ts extensions
export type ThemeChoice = 'system' | 'light' | 'dark'
export function readThemeChoice(): ThemeChoice          // defaults to 'system'
export function applyThemeChoice(c: ThemeChoice): void  // stores + resolves light/dark + listens to matchMedia
```

- [ ] **Step 1: Write the failing settings test**

`tests/web/settings.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { editorFontSize, initSettings, setEditorFontSize, setTreeFontSize, treeFontSize } from '../../src/web/state/settings.js'

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('style') })

describe('font size settings', () => {
  it('setEditorFontSize writes the signal + CSS variable + localStorage', () => {
    setEditorFontSize(18)
    expect(editorFontSize.value).toBe(18)
    expect(document.documentElement.style.getPropertyValue('--ink-font-size')).toBe('18px')
    expect(localStorage.getItem('inkstone.editorFontSize')).toBe('18')
  })
  it('setTreeFontSize likewise writes --ink-tree-font-size', () => {
    setTreeFontSize(16)
    expect(treeFontSize.value).toBe(16)
    expect(document.documentElement.style.getPropertyValue('--ink-tree-font-size')).toBe('16px')
  })
  it('initSettings applies stored values', () => {
    localStorage.setItem('inkstone.editorFontSize', '14')
    localStorage.setItem('inkstone.treeFontSize', '16')
    initSettings()
    expect(editorFontSize.value).toBe(14)
    expect(document.documentElement.style.getPropertyValue('--ink-font-size')).toBe('14px')
    expect(treeFontSize.value).toBe(16)
  })
  it('an invalid stored value falls back to the default', () => {
    localStorage.setItem('inkstone.editorFontSize', 'abc')
    initSettings()
    expect(editorFontSize.value).toBe(16)
  })
})
```

Append to `tests/web/theme.test.ts` (without changing the existing 6 cases):

```ts
describe('three-state theme', () => {
  it('readThemeChoice defaults to system', () => {
    localStorage.clear()
    expect(readThemeChoice()).toBe('system')
  })
  it('applyThemeChoice(dark) stores it and sets data-theme=dark', () => {
    applyThemeChoice('dark')
    expect(localStorage.getItem('inkstone.theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
  it('applyThemeChoice(system) follows matchMedia', () => {
    const mql = { matches: true, addEventListener() {}, removeEventListener() {} }
    vi.stubGlobal('matchMedia', () => mql)
    applyThemeChoice('system')
    expect(localStorage.getItem('inkstone.theme')).toBe('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark') // matches:true → dark
    vi.unstubAllGlobals()
  })
})
```
(Make sure the top of theme.test.ts imports `vi`, `readThemeChoice`, and `applyThemeChoice`.)

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/web/settings.test.ts tests/web/theme.test.ts`
Expected: the new cases FAIL

- [ ] **Step 3: Implement settings.ts**

```ts
import { signal } from '@preact/signals'

const EDITOR_KEY = 'inkstone.editorFontSize'
const TREE_KEY = 'inkstone.treeFontSize'
const EDITOR_SIZES = [14, 16, 18]
const TREE_SIZES = [13, 14, 16]

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function safeSet(key: string, v: string): void {
  try { localStorage.setItem(key, v) } catch { /* storage denied — in-memory state still applies */ }
}
function coerce(raw: string | null, allowed: number[], fallback: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10)
  return allowed.includes(n) ? n : fallback
}

export const editorFontSize = signal(coerce(safeGet(EDITOR_KEY), EDITOR_SIZES, 16))
export const treeFontSize = signal(coerce(safeGet(TREE_KEY), TREE_SIZES, 14))

export function setEditorFontSize(px: number): void {
  editorFontSize.value = px
  document.documentElement.style.setProperty('--ink-font-size', `${px}px`)
  safeSet(EDITOR_KEY, String(px))
}
export function setTreeFontSize(px: number): void {
  treeFontSize.value = px
  document.documentElement.style.setProperty('--ink-tree-font-size', `${px}px`)
  safeSet(TREE_KEY, String(px))
}
export function initSettings(): void {
  setEditorFontSize(coerce(safeGet(EDITOR_KEY), EDITOR_SIZES, 16))
  setTreeFontSize(coerce(safeGet(TREE_KEY), TREE_SIZES, 14))
}
```

- [ ] **Step 4: Extend useTheme.ts to three states**

Read the existing `useTheme.ts`. It currently has two states (`light|dark` + an OS fallback on first visit). Change it to: `inkstone.theme` stores `'system'|'light'|'dark'`; `applyThemeChoice` resolves the actual lightness and calls `setAttribute('data-theme', ...)`; under `'system'` it reads `matchMedia('(prefers-color-scheme: dark)')` and `addEventListener('change')` to follow dynamically (keep a module-level listener and remove it when switching away from system). Keep `safeGetItem`/`safeSetItem`. If the existing `applyTheme(light|dark)`/`readStoredTheme` are referenced by main.tsx's pre-paint script or elsewhere, preserve their behaviour or update the call sites. **Note the pre-paint script in `index.html`** (added in Phase 0 Task 9 to prevent FOUC) must also support `'system'`: it inlines a read of `inkstone.theme`, and when that is `'system'` or missing it should consult `matchMedia`. When changing the inline script in `index.html`, keep it in sync with the `KEY SYNC` comment in `useTheme.ts` (change both).

```ts
export type ThemeChoice = 'system' | 'light' | 'dark'
const THEME_KEY = 'inkstone.theme'
let systemListener: ((e: MediaQueryListEvent) => void) | null = null

export function readThemeChoice(): ThemeChoice {
  const raw = safeGetItem(THEME_KEY)
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}
function resolve(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'system') {
    try { return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }
    catch { return 'light' }
  }
  return choice
}
export function applyThemeChoice(choice: ThemeChoice): void {
  safeSetItem(THEME_KEY, choice)
  document.documentElement.setAttribute('data-theme', resolve(choice))
  const mql = (() => { try { return window.matchMedia?.('(prefers-color-scheme: dark)') } catch { return null } })()
  if (systemListener && mql) mql.removeEventListener('change', systemListener)
  systemListener = null
  if (choice === 'system' && mql) {
    systemListener = () => document.documentElement.setAttribute('data-theme', resolve('system'))
    mql.addEventListener('change', systemListener)
  }
}
```

- [ ] **Step 5: tokens.css + filetree.css + main.tsx**

Add `--ink-tree-font-size: 14px;` to `:root` in `tokens.css`. In `filetree.css`, change the hard-coded `font-size: 13px` (two places) to `font-size: var(--ink-tree-font-size);`. The editor already uses `--ink-font-size` (default 16px, already in tokens.css).

At startup (before rendering), `main.tsx` calls `initSettings()` and `applyThemeChoice(readThemeChoice())`, replacing the old `applyTheme(readStoredTheme())`.

- [ ] **Step 6: Run, confirm it passes + full frontend suite + typecheck**

Run: `pnpm vitest run --project web && pnpm typecheck`
Expected: green

- [ ] **Step 7: Commit**

```bash
git add src/web/state/settings.ts src/web/theme tokens.css src/web/filetree/filetree.css src/web/main.tsx tests/web/settings.test.ts tests/web/theme.test.ts
git commit -m "feat(web): add settings store with adjustable fonts and three-state theme"
```

---

### Task 5: SVG icon components + hover

**Files:**
- Create: `src/web/components/icons.tsx`, `src/web/components/icons.css`
- Test: `tests/web/icons.test.tsx`

**Interfaces:**
- Produces: one Preact component per icon, returning an 18×18 line SVG (`stroke="currentColor"` `stroke-width="1.8"` `fill="none"`) and accepting `class`/`title` props. Exports: `IconSidebar`, `IconRightPanel`, `IconSettings` (gear), `IconNewFile`, `IconNewFolder`, `IconRename`, `IconTrash`, `IconUnsavedDot`, `IconPushArrow`.

- [ ] **Step 1: Write the failing test**

`tests/web/icons.test.tsx`:

```tsx
import { render } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { IconSettings, IconTrash, IconUnsavedDot } from '../../src/web/components/icons.js'

describe('icons', () => {
  it('renders an svg stroked with currentColor', () => {
    const { container } = render(<IconSettings />)
    const svg = container.querySelector('svg')!
    expect(svg).toBeTruthy()
    expect(svg.getAttribute('stroke')).toBe('currentColor')
  })
  it('the gear carries the ink-icon-gear class (for the hover rotation)', () => {
    const { container } = render(<IconSettings />)
    expect(container.querySelector('svg')?.getAttribute('class') ?? '').toContain('ink-icon')
  })
  it('the unsaved dot is a filled small circle', () => {
    const { container } = render(<IconUnsavedDot />)
    expect(container.querySelector('circle')).toBeTruthy()
  })
  it('passes class through', () => {
    const { container } = render(<IconTrash class="foo" />)
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('foo')
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/web/icons.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement icons.tsx**

```tsx
import type { JSX } from 'preact'

interface IconProps { class?: string; title?: string }

function svg(children: JSX.Element, props: IconProps, extra = ''): JSX.Element {
  return (
    <svg
      class={`ink-icon ${extra} ${props.class ?? ''}`.trim()}
      width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round"
      role={props.title ? 'img' : undefined} aria-label={props.title} aria-hidden={props.title ? undefined : 'true'}
    >
      {props.title ? <title>{props.title}</title> : null}
      {children}
    </svg>
  )
}

export const IconSidebar = (p: IconProps) => svg(<><rect x="3" y="4" width="18" height="16" rx="1.5" /><line x1="9" y1="4" x2="9" y2="20" /></>, p)
export const IconRightPanel = (p: IconProps) => svg(<><rect x="3" y="4" width="18" height="16" rx="1.5" /><line x1="15" y1="4" x2="15" y2="20" /></>, p)
export const IconSettings = (p: IconProps) => svg(<><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" /></>, p, 'ink-icon-gear')
export const IconNewFile = (p: IconProps) => svg(<><path d="M14 3v5h5" /><path d="M6 3h9l5 5v13H6z" /><line x1="12" y1="12" x2="12" y2="18" /><line x1="9" y1="15" x2="15" y2="15" /></>, p)
export const IconNewFolder = (p: IconProps) => svg(<><path d="M3 6h6l2 2h10v11H3z" /><line x1="12" y1="12" x2="12" y2="17" /><line x1="9.5" y1="14.5" x2="14.5" y2="14.5" /></>, p)
export const IconRename = (p: IconProps) => svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>, p)
export const IconTrash = (p: IconProps) => svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></>, p)
export const IconPushArrow = (p: IconProps) => svg(<><line x1="12" y1="19" x2="12" y2="6" /><path d="M6 11l6-6 6 6" /></>, p)
export const IconUnsavedDot = (p: IconProps) => (
  <svg class={`ink-unsaved-dot ${p.class ?? ''}`.trim()} width="8" height="8" viewBox="0 0 8 8" aria-label={p.title ?? 'Unsaved'} role="img">
    <circle cx="4" cy="4" r="4" fill="currentColor" />
  </svg>
)
```

- [ ] **Step 4: icons.css (hover)**

```css
.ink-icon {
  color: var(--ink-fg-muted);
  transition: color 0.16s ease;
  flex-shrink: 0;
}
.ink-icon:hover { color: var(--ink-link); }

/* the gear alone: rotate on hover */
.ink-icon-gear { transition: color 0.16s ease, transform 0.4s ease; }
.ink-icon-gear:hover { color: var(--ink-link); transform: rotate(60deg); }

.ink-unsaved-dot { color: var(--ink-link); flex-shrink: 0; }
```

Note: hover is CSS-driven. When a button wraps the icon, applying `:hover` to the icon itself is enough (the icon is a child of the button, so a pointer over the button is over the icon too); if the button has padding, `button:hover .ink-icon { color: var(--ink-link) }` is more robust — pick one during implementation and make sure the button CSS propagates hover.

- [ ] **Step 5: Run and confirm it passes**

Run: `pnpm vitest run tests/web/icons.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/components/icons.tsx src/web/components/icons.css tests/web/icons.test.tsx
git commit -m "feat(web): add inline SVG icon set with color-shift hover, gear rotates"
```

---

### Task 6: The manual save model (rewriting document.ts)

**Files:**
- Modify: `src/web/state/document.ts`, `src/web/editor/Editor.tsx` (remove the cancelPendingSave timer semantics on unmount), `src/web/App.tsx` (beforeunload)
- Test: `tests/web/document.test.ts` (rewrite the autosave-related cases)

**Interfaces:**
- Consumes: `api.writeFile`, `ConflictError`, `currentPath`
- Produces:
```ts
export const content: Signal<string>
export const dirty: Signal<boolean>          // memory vs disk, drives the unsaved dot
export const saveError: Signal<string | null>
export const conflict: Signal<Conflict | null>   // kept
export const baseMtimeMs: Signal<number | null>  // kept
export function editContent(next: string): void  // sets dirty + writes the draft, no timer
export function flushSave(): Promise<void>        // Ctrl+S manual save
export function openFile(path: string): Promise<void>
export function handleExternalChange(path: string, mtimeMs: number): Promise<void>  // kept
export function resolveConflictTakeDisk(): void   // kept
export function resolveConflictKeepMine(): Promise<void>  // kept
export const DRAFT_KEY_PREFIX: string
```
**Removed**: the `saveState` signal, `cancelPendingSave`, and the debounce timer `saveTimer`/`SAVE_DEBOUNCE_MS`.

- [ ] **Step 1: Change the tests**

Read the existing `tests/web/document.test.ts`. Delete or rewrite the cases under the "autosave" describe that depend on debounced automatic persistence (such as "persists after a 1000ms debounce", "unsaved the instant you type", "still unsaved when typing during a save" — the Phase 0 / bc3e002 ones), replacing them with manual-save semantics:

```ts
describe('manual save', () => {
  it('editContent sets dirty but does not auto-persist', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    writeFile.mockResolvedValue({ mtimeMs: 2 })
    await openFile('a.md')
    editContent('typed')
    expect(dirty.value).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)     // no amount of waiting should persist it
    expect(writeFile).not.toHaveBeenCalled()
  })
  it('flushSave persists and clears dirty + clears the draft', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    writeFile.mockResolvedValue({ mtimeMs: 9 })
    await openFile('a.md')
    editContent('typed')
    await flushSave()
    expect(writeFile).toHaveBeenCalledWith('a.md', 'typed', 1)
    expect(dirty.value).toBe(false)
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBeNull()
  })
  it('editContent writes the draft synchronously (crash-fallback retention)', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    await openFile('a.md')
    editContent('draft-me')
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBe('draft-me')
  })
  it('a failed save retains dirty + draft + saveError', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    writeFile.mockRejectedValue(new clientModule.ApiError('disk full', 500))
    await openFile('a.md')
    editContent('changed')
    await flushSave()
    expect(dirty.value).toBe(true)
    expect(saveError.value).toContain('disk full')
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBe('changed')
  })
})
```
Leave the conflict/handleExternalChange cases untouched (that logic is unchanged), but drop their assertions on `saveState` (assert `dirty`/`saveError`/`conflict` instead).

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/web/document.test.ts`
Expected: FAIL (saveState assertions removed, or the debounce cases changed)

- [ ] **Step 3: Rewrite document.ts**

Remove `saveState`, `SAVE_DEBOUNCE_MS`, `saveTimer`, `cancelPendingSave`, and `clearTimer`. `editContent` only sets dirty + writes the draft; `flushSave` is the manual version of the existing `performSave`.

```ts
export const dirty = signal(false)
export const saveError = signal<string | null>(null)
// ... content/baseMtimeMs/conflict are kept

export function editContent(next: string): void {
  content.value = next
  dirty.value = true
  const path = currentPath.value
  if (path) {
    try { localStorage.setItem(draftKey(path), next) } catch { /* a failed fallback write must not block editing */ }
  }
}

export async function flushSave(): Promise<void> {
  const path = currentPath.value
  if (!path || !dirty.value) return
  const snapshot = content.value
  try {
    const result = await api.writeFile(path, snapshot, baseMtimeMs.value ?? undefined)
    baseMtimeMs.value = result.mtimeMs
    saveError.value = null
    if (content.value === snapshot) {
      dirty.value = false
      localStorage.removeItem(draftKey(path))
    }
    // a save may proactively trigger a git status refresh (Tasks 10/11 fetch it in the UI layer); no hard coupling here
  } catch (err) {
    if (err instanceof ConflictError) {
      conflict.value = { diskContent: err.disk.content, diskMtimeMs: err.disk.mtimeMs }
      saveError.value = 'The file has changed on disk'
      return
    }
    saveError.value = err instanceof Error ? err.message : String(err)
  }
}
```
Keep `openFile` (including the draft restoration logic), but delete its assignments to `saveState` and set `saveError.value = null` instead. Keep `resolveConflict*`/`handleExternalChange`, deleting their `saveState` assignments.

- [ ] **Step 4: Editor.tsx unmount + Ctrl+S**

`Editor.tsx`'s existing unmount cleanup calls `cancelPendingSave()` — delete that line (the timer no longer exists), leaving only `view.destroy()`. Keep the Ctrl+S binding (`Mod-s` → `flushSave`). Keep the `lastPathRef` logic that rebuilds state on a file switch.

- [ ] **Step 5: App.tsx beforeunload**

In `App.tsx`'s mount effect add:

```ts
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.value) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    // removeEventListener in the cleanup
```
And remove App.tsx's import/use of `saveState` (the top bar's save text goes away in Task 7).

- [ ] **Step 6: Run, confirm it passes + full frontend + typecheck**

Run: `pnpm vitest run --project web && pnpm typecheck`
Expected: green (if TopBar still references saveState it will be a type error → handled in Task 7; for now this task just stops App.tsx from passing saveState, and TopBar's saveState prop can be temporarily optional or changed together in Task 7. To avoid breaking the intermediate state, this step allows TopBar to ignore the prop for now)

If TopBar's types block progress, this task makes TopBar's `saveState` prop optional and stops rendering it (Task 7 rewrites TopBar entirely).

- [ ] **Step 7: Commit**

```bash
git add src/web/state/document.ts src/web/editor/Editor.tsx src/web/App.tsx tests/web/document.test.ts src/web/layout/TopBar.tsx
git commit -m "feat(web): switch to manual save (Ctrl+S), dirty signal drives unsaved state"
```

---

### Task 7: Top/status bar polish (direction B) + the breadcrumb unsaved dot

**Files:**
- Modify: `src/web/theme/tokens.css` (heights), `src/web/layout/TopBar.tsx`, `src/web/layout/StatusBar.tsx`, `src/web/layout/shell.css` (or the corresponding layout css), `src/web/App.tsx` (wiring)
- Test: `tests/web/topbar.test.tsx`

**Interfaces:**
- Consumes: `icons.tsx` (Task 5), `dirty`/`currentPath` (Task 6), `toggleLeftPanel`/`toggleRightPanel` (existing ui.ts), a callback to open settings (Task 9 provides `openSettings`; this task wires an `onOpenSettings` prop for now)
- Produces: the rewritten TopBar (SVG icons + a breadcrumb with the dot + the gear) and StatusBar (word/char counts + a placeholder git area; the commit/push buttons come in Task 10)

- [ ] **Step 1: Write the failing topbar test**

`tests/web/topbar.test.tsx`:

```tsx
import { render } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import { TopBar } from '../../src/web/layout/TopBar.js'
import { dirty } from '../../src/web/state/document.js'
import { currentPath } from '../../src/web/state/vault.js'

beforeEach(() => { dirty.value = false; currentPath.value = null })

describe('TopBar', () => {
  it('shows the dot in the breadcrumb when there are unsaved changes and a file is open', () => {
    currentPath.value = 'notes/a.md'; dirty.value = true
    const { container } = render(<TopBar onOpenSettings={() => {}} />)
    expect(container.querySelector('.ink-unsaved-dot')).toBeTruthy()
  })
  it('shows no dot when there is nothing unsaved', () => {
    currentPath.value = 'notes/a.md'; dirty.value = false
    const { container } = render(<TopBar onOpenSettings={() => {}} />)
    expect(container.querySelector('.ink-unsaved-dot')).toBeNull()
  })
  it('renders the gear settings icon', () => {
    const { container } = render(<TopBar onOpenSettings={() => {}} />)
    expect(container.querySelector('.ink-icon-gear')).toBeTruthy()
  })
  it('no longer renders save-state text', () => {
    currentPath.value = 'a.md'; dirty.value = true
    const { getByText } = render(<TopBar onOpenSettings={() => {}} />)
    expect(() => getByText('Unsaved')).toThrow()
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/web/topbar.test.tsx`
Expected: FAIL

- [ ] **Step 3: tokens.css heights**

`--ink-topbar-height: 32px` → `48px`; `--ink-statusbar-height: 24px` → `32px`. The top bar's font size goes from 12px to 14px in shell.css, and `gap`/`padding` go to 16px.

- [ ] **Step 4: Rewrite TopBar.tsx**

```tsx
import { IconSidebar, IconRightPanel, IconSettings, IconUnsavedDot } from '../components/icons.js'
import { toggleLeftPanel, toggleRightPanel } from '../state/ui.js'
import { dirty } from '../state/document.js'
import { currentPath } from '../state/vault.js'

export interface TopBarProps { onOpenSettings: () => void }

export function TopBar({ onOpenSettings }: TopBarProps) {
  const path = currentPath.value
  return (
    <>
      <button type="button" class="ink-iconbtn" onClick={toggleLeftPanel} title="Toggle file tree"><IconSidebar /></button>
      <span class="ink-breadcrumb">
        {path && dirty.value ? <IconUnsavedDot title="Unsaved" /> : null}
        {path ?? 'No file open'}
      </span>
      <span style={{ marginLeft: 'auto' }} />
      <button type="button" class="ink-iconbtn" onClick={onOpenSettings} title="Settings"><IconSettings /></button>
      <button type="button" class="ink-iconbtn" onClick={toggleRightPanel} title="Toggle right panel"><IconRightPanel /></button>
    </>
  )
}
```
`.ink-iconbtn` (in shell.css or a new css file): no border, no background, `display:inline-flex; align-items:center; padding:5px; cursor:pointer;`, plus `:hover .ink-icon { color: var(--ink-link) }` (to make sure hover propagates to the icon). The breadcrumb is `display:inline-flex; align-items:center; gap:6px;`.

- [ ] **Step 5: StatusBar.tsx**

Keep the word/character counts; leave a placeholder git container on the right (Task 10 fills in commit/push). Remove any saveState reference. Font size follows the raised --ink-statusbar.

- [ ] **Step 6: Wire up App.tsx**

Change TopBar's usage to `<TopBar onOpenSettings={...} />` (before Task 9, pass a `() => {}` placeholder, or merge this task with Task 9 and wire the `openSettings` signal). Remove the saveState argument from App.tsx.

- [ ] **Step 7: Run, confirm it passes + typecheck + build**

Run: `pnpm vitest run --project web && pnpm typecheck && pnpm exec vite build`
Expected: green

- [ ] **Step 8: Commit**

```bash
git add src/web/layout src/web/theme/tokens.css src/web/App.tsx tests/web/topbar.test.tsx
git commit -m "feat(web): polish top/bottom bars (48/32px, SVG icons), breadcrumb unsaved dot"
```

---

### Task 8: File-tree operations UI (create/rename/delete) + the per-row unsaved dot

**Files:**
- Modify: `src/web/state/vault.ts` (add `pendingOp`), `src/web/filetree/FileTree.tsx`, `src/web/filetree/TreeNode.tsx`, `src/web/filetree/filetree.css`
- Test: `tests/web/filetree.test.tsx` (append; do not change the existing 9 cases)

**Interfaces:**
- Consumes: `api.createEntry/rename/remove`, `refreshTree`, `treeError`, `currentPath`, `dirty`, `openFile`, `IconNewFile/IconNewFolder/IconRename/IconTrash/IconUnsavedDot`
- Produces:
```ts
// vault.ts
export type PendingOp =
  | { kind: 'create-file' | 'create-dir'; parent: string }
  | { kind: 'rename'; path: string; initialName: string }
export const pendingOp: Signal<PendingOp | null>
export function startCreate(kind: 'create-file' | 'create-dir'): void  // parent = the selected directory or the root
export function startRename(path: string): void
export function cancelPending(): void
export async function commitCreate(name: string): Promise<void>
export async function commitRename(name: string): Promise<void>
export async function deleteEntry(path: string): Promise<void>
```

- [ ] **Step 1: Write the failing test**

Append to `tests/web/filetree.test.tsx` (mocking `api`):

```tsx
describe('file tree operations', () => {
  it('new document: the header button sets pendingOp, submitting calls createEntry and opens it', async () => {
    const create = vi.spyOn(clientApi, 'createEntry').mockResolvedValue()
    vi.spyOn(clientApi, 'tree').mockResolvedValue([])
    render(<FileTree onOpenFile={() => {}} />)
    fireEvent.click(screen.getByTitle('New file'))
    const input = screen.getByRole('textbox')
    fireEvent.input(input, { target: { value: 'new.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(create).toHaveBeenCalledWith('new.md', 'file'))
  })
  it('delete: calls remove after the inline confirmation', async () => {
    tree.value = [{ name: 'a.md', path: 'a.md', type: 'file' }]
    const remove = vi.spyOn(clientApi, 'remove').mockResolvedValue()
    vi.spyOn(clientApi, 'tree').mockResolvedValue([])
    render(<FileTree onOpenFile={() => {}} />)
    // hover reveals the delete icon → click → inline confirm ✓
    fireEvent.click(screen.getByTitle('Delete a.md'))
    fireEvent.click(screen.getByTitle('Confirm delete'))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('a.md'))
  })
  it('the current dirty file row shows the unsaved dot', () => {
    tree.value = [{ name: 'a.md', path: 'a.md', type: 'file' }]
    currentPath.value = 'a.md'; dirty.value = true
    const { container } = render(<FileTree onOpenFile={() => {}} />)
    expect(container.querySelector('.ink-unsaved-dot')).toBeTruthy()
  })
  it('a failed rename sets treeError', async () => {
    tree.value = [{ name: 'a.md', path: 'a.md', type: 'file' }]
    vi.spyOn(clientApi, 'rename').mockRejectedValue(new Error('boom'))
    vi.spyOn(clientApi, 'tree').mockResolvedValue([])
    render(<FileTree onOpenFile={() => {}} />)
    fireEvent.click(screen.getByTitle('Rename a.md'))
    const input = screen.getByRole('textbox')
    fireEvent.input(input, { target: { value: 'b.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(treeError.value).not.toBeNull())
  })
})
```
(Import `clientApi` — i.e. `api` — plus `treeError`/`dirty`/`currentPath`/`fireEvent`/`waitFor`/`screen` at the top.)

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/web/filetree.test.tsx`
Expected: the new cases FAIL

- [ ] **Step 3: The operation logic in vault.ts**

```ts
export type PendingOp =
  | { kind: 'create-file' | 'create-dir'; parent: string }
  | { kind: 'rename'; path: string; initialName: string }
export const pendingOp = signal<PendingOp | null>(null)

function targetDir(): string {
  const p = currentPath.value
  if (!p) return ''
  // if the selection is a directory use it; if a file, use its parent
  const entry = findEntry(tree.value, p)
  if (entry?.type === 'dir') return p
  const slash = p.lastIndexOf('/')
  return slash === -1 ? '' : p.slice(0, slash)
}
export function startCreate(kind: 'create-file' | 'create-dir'): void {
  pendingOp.value = { kind, parent: targetDir() }
}
export function startRename(path: string): void {
  const name = path.slice(path.lastIndexOf('/') + 1)
  pendingOp.value = { kind: 'rename', path, initialName: name }
}
export function cancelPending(): void { pendingOp.value = null }

export async function commitCreate(name: string): Promise<void> {
  const op = pendingOp.value
  if (!op || op.kind === 'rename' || !name.trim()) { pendingOp.value = null; return }
  const path = op.parent ? `${op.parent}/${name}` : name
  pendingOp.value = null
  try {
    await api.createEntry(path, op.kind === 'create-dir' ? 'dir' : 'file')
    await refreshTree()
    if (op.kind === 'create-file') { const { openFile } = await import('./document.js'); await openFile(path) }
  } catch (e) { treeError.value = 'Create failed' }
}
export async function commitRename(name: string): Promise<void> {
  const op = pendingOp.value
  if (!op || op.kind !== 'rename' || !name.trim()) { pendingOp.value = null; return }
  const slash = op.path.lastIndexOf('/')
  const to = slash === -1 ? name : `${op.path.slice(0, slash)}/${name}`
  pendingOp.value = null
  try {
    await api.rename(op.path, to)
    if (currentPath.value === op.path) currentPath.value = to
    await refreshTree()
  } catch (e) { treeError.value = 'Rename failed' }
}
export async function deleteEntry(path: string): Promise<void> {
  try {
    await api.remove(path)
    if (currentPath.value === path) { currentPath.value = null }
    await refreshTree()
  } catch (e) { treeError.value = 'Delete failed' }
}
```
If vault.ts has no `findEntry(tree, path)`, add a recursive lookup helper. Avoid a circular dependency between `openFile` and document.ts: use a dynamic `import('./document.js')` (as above) or turn the openFile call into a callback.

- [ ] **Step 4: FileTree.tsx header toolbar + pendingOp rendering**

One header row: `<button title="New file" onClick={() => startCreate('create-file')}><IconNewFile/></button>` and `New folder`. When `pendingOp` is a create whose parent matches a directory (or the root), render an input row there (a controlled input; Enter→`commitCreate(value)`, Esc/blur→`cancelPending()`).

- [ ] **Step 5: TreeNode.tsx hover actions + the dot + delete confirmation**

Each row floats two small icon buttons on the right on hover (shown/hidden with CSS `:hover`): `Rename` (`title="Rename {name}"`) and `Delete` (`title="Delete {name}"`). Clicking delete switches that row's local state to a confirmation: "✓ (`title="Confirm delete"`, onClick→`deleteEntry(path)`) ✗ (→cancel)". When the row is `currentPath` and `dirty`, render `<IconUnsavedDot/>` to the left of the filename. In rename state the filename becomes a controlled input (Enter→`commitRename`).

- [ ] **Step 6: filetree.css**

Hover action icons default to `opacity:0` and go to `opacity:1` on `.ink-tree-row:hover`; the dot sits left of the name with `margin-right:4px`. Keep it borderless and square-cornered.

- [ ] **Step 7: Run, confirm it passes + full frontend + typecheck**

Run: `pnpm vitest run --project web && pnpm typecheck`
Expected: green (the existing 9 file-tree cases are unaffected)

- [ ] **Step 8: Commit**

```bash
git add src/web/state/vault.ts src/web/filetree tests/web/filetree.test.tsx
git commit -m "feat(web): file tree create/rename/delete UI with inline unsaved dot"
```

---

### Task 9: The settings modal + wiring the gear + api.vaultInfo

**Files:**
- Create: `src/web/components/SettingsModal.tsx`, `src/web/components/settingsmodal.css`
- Modify: `src/web/state/ui.ts` (add the `settingsOpen` signal), `src/web/api/client.ts` (add `vaultInfo`/`logout`), `src/web/App.tsx` (mount the modal + wire TopBar's onOpenSettings)
- Test: `tests/web/settingsmodal.test.tsx`, `tests/web/api/client.test.ts` (append vaultInfo)

**Interfaces:**
- Consumes: `editorFontSize/treeFontSize/setEditorFontSize/setTreeFontSize` (Task 4), `readThemeChoice/applyThemeChoice` (Task 4), `api.vaultInfo/logout`
- Produces:
```ts
// ui.ts
export const settingsOpen: Signal<boolean>
export function openSettings(): void
export function closeSettings(): void
// client.ts
api.vaultInfo(): Promise<{ root: string }>
api.gitStatus(): Promise<{ dirty; branch; hasRemote; ahead }>   // extend the return type if Phase 0 already has it
api.commit(message: string): Promise<{ sha; files } | null>
api.push(): Promise<{ pushed: number }>
```
(Task 10 needs the commit/push client methods too, so add them all here.)

- [ ] **Step 1: Write the failing test**

`tests/web/settingsmodal.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../../src/web/components/SettingsModal.js'
import { settingsOpen } from '../../src/web/state/ui.js'
import { editorFontSize } from '../../src/web/state/settings.js'
import * as client from '../../src/web/api/client.js'

beforeEach(() => { settingsOpen.value = true; localStorage.clear()
  vi.spyOn(client.api, 'vaultInfo').mockResolvedValue({ root: '/vault' }) })

describe('SettingsModal', () => {
  it('renders the appearance/font-size/vault rows when open', async () => {
    render(<SettingsModal />)
    expect(screen.getByText('Appearance')).toBeTruthy()
    expect(screen.getByText('Editor font size')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('/vault')).toBeTruthy())
  })
  it('changing the editor font size writes the signal', () => {
    render(<SettingsModal />)
    fireEvent.change(screen.getByLabelText('Editor font size'), { target: { value: '18' } })
    expect(editorFontSize.value).toBe(18)
  })
  it('Esc closes it', () => {
    render(<SettingsModal />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(settingsOpen.value).toBe(false)
  })
  it('renders nothing when settingsOpen=false', () => {
    settingsOpen.value = false
    const { container } = render(<SettingsModal />)
    expect(container.querySelector('.ink-settings')).toBeNull()
  })
  it('log out calls logout', async () => {
    const logout = vi.spyOn(client.api, 'logout').mockResolvedValue()
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Log out'))
    await waitFor(() => expect(logout).toHaveBeenCalled())
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/web/settingsmodal.test.tsx`
Expected: FAIL

- [ ] **Step 3: Add the client.ts methods**

```ts
  vaultInfo(): Promise<{ root: string }> { return request('/api/vault/info') },
  async logout(): Promise<void> { await request('/api/logout', { method: 'POST' }) },
  gitStatus(): Promise<{ dirty: boolean; branch: string; hasRemote: boolean; ahead: number }> { return request('/api/git/status') },
  commit(message: string): Promise<{ sha: string; files: string[] } | null> {
    return request('/api/git/commit', { method: 'POST', body: JSON.stringify({ message }) })
  },
  push(): Promise<{ pushed: number }> { return request('/api/git/push', { method: 'POST' }) },
```
(Adjust to the existing `request` helper's signature; skip `logout` if Phase 0 already has it.)

- [ ] **Step 4: The ui.ts signal + SettingsModal.tsx**

Add a `settingsOpen` signal plus `openSettings`/`closeSettings` to `ui.ts`.

`SettingsModal.tsx`: return null when `settingsOpen.value` is false. Otherwise render a backdrop (`.ink-settings-backdrop`, click to close) plus the panel (`.ink-settings`, `role="dialog"`). Rows:
- Appearance: three icon buttons, system/light/dark, the current one highlighted, clicking calls `applyThemeChoice(...)`
- Editor font size: `<select aria-label="Editor font size">` 14/16/18, `onChange` → `setEditorFontSize(Number(...))`
- Tree font size: likewise 13/14/16 → `setTreeFontSize`
- Vault: a `useEffect` fetches `api.vaultInfo()` and shows the root (read-only)
- Remote: shows `hasRemote ? 'origin ✓' : 'No remote'` (fetching `api.gitStatus()`)
- Log out button → `await api.logout(); location.reload()`
Esc closes (document keydown). The backdrop/panel may use shadows (they are overlays).

- [ ] **Step 5: Wire App.tsx + the TopBar gear**

App.tsx renders `<SettingsModal />`, and TopBar gets `onOpenSettings={openSettings}`.

- [ ] **Step 6: Append the vaultInfo case to client.test.ts, run the full frontend + typecheck**

Run: `pnpm vitest run --project web && pnpm typecheck`
Expected: green

- [ ] **Step 7: Commit**

```bash
git add src/web/components/SettingsModal.tsx src/web/components/settingsmodal.css src/web/state/ui.ts src/web/api/client.ts src/web/App.tsx tests/web/settingsmodal.test.tsx tests/web/api/client.test.ts
git commit -m "feat(web): add settings modal (theme, fonts, vault info, logout)"
```

---

### Task 10: Status-bar commit / push buttons + confirmation + git status

**Files:**
- Modify: `src/web/layout/StatusBar.tsx`, `src/web/state/git.ts` (new; git state signals + actions), `src/web/App.tsx` (consume the WS git-status + initial fetch), `src/web/layout/statusbar.css`
- Test: `tests/web/git-actions.test.tsx`

**Interfaces:**
- Consumes: `api.gitStatus/commit/push`, `dirty`, `IconPushArrow`
- Produces:
```ts
// state/git.ts
export const gitStatus: Signal<{ dirty; branch; hasRemote; ahead }>
export const gitBusy: Signal<'idle' | 'committing' | 'pushing'>
export const gitError: Signal<string | null>
export async function refreshGitStatus(): Promise<void>
export async function commitVault(): Promise<void>       // composes the manual: <timestamp> message
export async function pushVault(): Promise<void>          // called after the UI confirmation
```

- [ ] **Step 1: Write the failing test**

`tests/web/git-actions.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StatusBar } from '../../src/web/layout/StatusBar.js'
import { gitStatus } from '../../src/web/state/git.js'
import * as client from '../../src/web/api/client.js'

beforeEach(() => { gitStatus.value = { dirty: true, branch: 'main', hasRemote: true, ahead: 3 } })

describe('status-bar git buttons', () => {
  it('the commit button is clickable while dirty and calls commit', async () => {
    const commit = vi.spyOn(client.api, 'commit').mockResolvedValue({ sha: 'a'.repeat(40), files: ['a.md'] })
    vi.spyOn(client.api, 'gitStatus').mockResolvedValue({ dirty: false, branch: 'main', hasRemote: true, ahead: 3 })
    render(<StatusBar words={0} chars={0} />)
    fireEvent.click(screen.getByText('Commit'))
    await waitFor(() => expect(commit).toHaveBeenCalled())
    expect(commit.mock.calls[0][0]).toMatch(/^manual:/)
  })
  it('shows Push 3 when hasRemote and ahead>0', () => {
    render(<StatusBar words={0} chars={0} />)
    expect(screen.getByText(/Push 3/)).toBeTruthy()
  })
  it('push confirms first, then calls push', async () => {
    const push = vi.spyOn(client.api, 'push').mockResolvedValue({ pushed: 3 })
    vi.spyOn(client.api, 'gitStatus').mockResolvedValue({ dirty: true, branch: 'main', hasRemote: true, ahead: 0 })
    render(<StatusBar words={0} chars={0} />)
    fireEvent.click(screen.getByText(/Push 3/))
    fireEvent.click(await screen.findByText(/Confirm/))   // the confirm button in the confirmation
    await waitFor(() => expect(push).toHaveBeenCalled())
  })
  it('shows no push button when there is no remote', () => {
    gitStatus.value = { dirty: true, branch: 'main', hasRemote: false, ahead: 0 }
    render(<StatusBar words={0} chars={0} />)
    expect(screen.queryByText(/Push/)).toBeNull()
  })
})
```

- [ ] **Step 2: Run, confirm it fails → implement state/git.ts**

```ts
import { signal } from '@preact/signals'
import { api } from '../api/client.js'

export const gitStatus = signal({ dirty: false, branch: 'main', hasRemote: false, ahead: 0 })
export const gitBusy = signal<'idle' | 'committing' | 'pushing'>('idle')
export const gitError = signal<string | null>(null)

export async function refreshGitStatus(): Promise<void> {
  try { gitStatus.value = await api.gitStatus() } catch { /* keep the previous value */ }
}
export async function commitVault(): Promise<void> {
  gitBusy.value = 'committing'; gitError.value = null
  try {
    const stamp = new Date().toLocaleString('sv')  // the frontend composes the timestamp (sv → YYYY-MM-DD HH:mm:ss)
    await api.commit(`manual: ${stamp}`)
    await refreshGitStatus()
  } catch (e) { gitError.value = e instanceof Error ? e.message : 'Commit failed' }
  finally { gitBusy.value = 'idle' }
}
export async function pushVault(): Promise<void> {
  gitBusy.value = 'pushing'; gitError.value = null
  try { await api.push(); await refreshGitStatus() }
  catch (e) { gitError.value = e instanceof Error ? e.message : 'Push failed' }
  finally { gitBusy.value = 'idle' }
}
```

- [ ] **Step 3: StatusBar.tsx**

Word/character counts unchanged. On the right: `{gitStatus.value.branch} {gitStatus.value.dirty ? '●' : ''}`; a **Commit** button (`disabled` when `!gitStatus.value.dirty`, onClick→`commitVault`); when `hasRemote` and `ahead>0`, a **Push N** button (with `IconPushArrow`) whose click sets a local `confirmPush` state showing the inline confirmation "Push N commits to {branch}? Confirm Cancel", with Confirm→`pushVault`. Red text when `gitError` is non-null. The corresponding button spins/disables while `gitBusy`.

- [ ] **Step 4: Wire App.tsx**

Call `refreshGitStatus()` on mount; a WS `git-status` event updates `gitStatus.value`; also `refreshGitStatus()` after a successful save (flushSave) — either by listening in App or by calling it after flushSave.

- [ ] **Step 5: Run, confirm it passes + full frontend + typecheck + build**

Run: `pnpm vitest run --project web && pnpm typecheck && pnpm exec vite build`
Expected: green

- [ ] **Step 6: Commit**

```bash
git add src/web/state/git.ts src/web/layout/StatusBar.tsx src/web/layout/statusbar.css src/web/App.tsx tests/web/git-actions.test.tsx
git commit -m "feat(web): status-bar commit/push buttons with push confirmation"
```

---

### Task 11: End-to-end smoke + integration verification

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`, `tests/e2e/server.mjs` (if more seeding is needed)
- Test: Playwright

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Append the e2e cases**

Append to `tests/e2e/smoke.spec.ts` (after logging in):

```ts
test('file tree: create → rename → delete', async ({ page }) => {
  await login(page)  // reuse the existing login helper
  await page.getByTitle('New file').click()
  await page.getByRole('textbox').fill('e2e-new.md')
  await page.getByRole('textbox').press('Enter')
  await expect(page.getByText('e2e-new.md')).toBeVisible()
  // rename
  await page.getByText('e2e-new.md').hover()
  await page.getByTitle('Rename e2e-new.md').click()
  await page.getByRole('textbox').fill('e2e-renamed.md')
  await page.getByRole('textbox').press('Enter')
  await expect(page.getByText('e2e-renamed.md')).toBeVisible()
  // delete
  await page.getByText('e2e-renamed.md').hover()
  await page.getByTitle('Delete e2e-renamed.md').click()
  await page.getByTitle('Confirm delete').click()
  await expect(page.getByText('e2e-renamed.md')).toHaveCount(0)
})

test('manual save: the dot appears on edit → Ctrl+S makes it disappear', async ({ page }) => {
  await login(page)
  await page.getByText('notes').click()
  await page.getByText('welcome.md').click()  // a file from the seed
  await page.locator('.cm-content').click()
  await page.keyboard.type('edit')
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
})
```
(If the existing e2e has no `login` helper, inline the login steps. The seeded vault must contain `notes/welcome.md` — check the seed in `server.mjs` and add it if missing.)

- [ ] **Step 2: Run the full suite + build + e2e**

Run: `pnpm vitest run && pnpm typecheck && pnpm build && pnpm exec playwright test`
Expected: unit tests all green (re-run the watcher/ws flakes), e2e all green

- [ ] **Step 3: Manual verification (performed by the controller)**

Start the real service against a temporary vault (see the startup procedure in Phase 0 Task 13) and confirm by hand: create/rename/delete in the file tree; the dot appears on edit and disappears on Ctrl+S; the settings modal applies font sizes immediately, the three-state theme, log out; the status-bar commit button; and (with a remote) the push confirmation flow.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e
git commit -m "test(e2e): cover file tree ops and manual-save dot"
```

---

## Completion criteria

- [ ] `pnpm vitest run` all green (the watcher/ws flakes go green on a re-run)
- [ ] `pnpm typecheck` reports no errors
- [ ] `pnpm build` successfully produces dist/server + dist/web
- [ ] `pnpm exec playwright test` all green
- [ ] Manual: file-tree create/rename/delete, the manual-save dot, the settings modal (immediate font sizes / three-state theme / log out), the status-bar commit, and (with a remote) the push confirmation
- [ ] Top bar 48 / status bar 32, SVG icons, the gear rotating on hover and the rest changing color
- [ ] No autosave (editing does not persist, only Ctrl+S); closing the tab shows the beforeunload warning
