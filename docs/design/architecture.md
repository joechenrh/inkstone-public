# Architecture

Inkstone is a self-hosted web Typora over a git-backed markdown vault. One Fastify process serves both the API and the built SPA; there is no database.

It runs in one of **two modes**, decided entirely by which environment variables are set, and they are different enough that the threat model below has to be stated twice.

| | **vault** | **github** |
|---|---|---|
| Set by | `VAULT_ROOT` + `AUTH_PASSWORD` | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` |
| The data model | The vault directory on disk | The user's own GitHub repository; this server has no copy |
| Sign-in | One shared password | GitHub, per user |
| `/api/tree`, `/api/file*`, `/api/git/*` | Registered | **Not registered.** The browser calls `api.github.com` itself |
| Watcher, autocommit | Running | Absent — there is nothing to watch |

Both may be set, which is the development arrangement; the browser is then offered GitHub sign-in and the vault stays reachable behind its password.

**A third switch, independent of both:** `SHARE_DIR` turns on read-only share links and is the only state this server keeps that outlives a request. It requires the GitHub pair beside it, because every share is attributed to the account that made it. Unset, the routes are not registered, `/api/config` reports `sharing: false`, and the app never offers the menu item. See [sharing.md](sharing.md).

## Threat model and deployment posture

**vault mode: intranet or Tailscale only.** The server writes files anywhere under `VAULT_ROOT`, has one shared password, no multi-user isolation, and no CSRF token beyond the SameSite cookie — and Phase 3 was to add an agent process with that same write access, until it moved to the user's own machine ([agent.md](agent.md)). Reaching it at all is most of the way to owning what is in it. `LISTEN_ADDR` defaults to `127.0.0.1` and must never be `0.0.0.0`.

**github mode: the public internet is what it is for.** This is not the old rule relaxed; it is the design that made the rule unnecessary. There is no vault on the machine, no shared password, and no per-user state: the browser reads and writes `api.github.com` directly, and this server exchanges a sign-in code for a token and forgets. The access token goes to the browser and is held in memory; the refresh token is an `httpOnly` signed cookie, spendable by script on the origin but not readable. The only secret here is the App's client secret, which belongs to the app rather than to any user. See [public-route.md](public-route.md).

The rule that used to be stated flatly — *never expose this to the public internet* — was correct for the only mode that existed when it was written, and it still binds that mode. What changed is that there is now a second one with nothing to expose.

A second consequence: **no external CDN**. Every asset — Vditor's runtime bundles, the lute WASM/JS engine, icons, emoji, and the rendering fonts — is vendored and served from the same origin, so the app works on a network with no internet route and leaks nothing about what is being edited. An e2e test asserts zero non-localhost requests.

## Processes and build

| Piece | Source | Build output |
|---|---|---|
| Server | `src/server/` (TypeScript, ESM) | `tsc -p tsconfig.server.json` → `dist/server/` |
| Web SPA | `src/web/` (Preact + TSX) | `vite build` → `dist/web/` |
| Vendored assets | `node_modules/vditor/dist` | `scripts/prepare-assets.mjs` → `public/vditor/dist` |

`prepare-assets` runs from the `prebuild` and `predev:web` hooks (enabled by `enable-pre-post-scripts=true` in `.npmrc`). `public/vditor/` is git-ignored — it is a build artifact, regenerated from the pinned dependency.

`node dist/server/main.js` serves `dist/web/` statically with an SPA fallback. `index.html` is sent `no-store`; hashed assets are `max-age=31536000, immutable`. The `cacheControl: false` option on `@fastify/static` is load-bearing — without it the plugin's own default header overwrites those values.

## Server modules

| Module | Responsibility |
|---|---|
| `config.ts` | Reads and validates env; decides the mode, and fails fast on half of either one |
| `app.ts` | Fastify assembly, static serving, cache headers, SPA fallback |
| `auth.ts` | `POST /api/login`, `POST /api/logout`, `GET /api/health`, `GET /api/config`; signed session cookie. The guard is not installed in github mode — there is nothing behind it |
| `github-auth.ts` | The four sign-in routes, and the return path a share link's sign-in comes back to. Everything this server does for github mode |
| `share/store.ts` | Shared notes on disk: two files per share, a metadata index in memory, two expiry clocks and the daily sweep |
| `share/viewer.ts` | Whose GitHub token this is. The security-critical half of sharing, kept apart from routing |
| `share/routes.ts` | The four share routes. Only registered when `SHARE_DIR` is set |
| `vault/paths.ts` | Path containment — every client path is resolved and rejected if it escapes the vault root |
| `vault/index.ts` | Tree listing, read, write, create, rename, delete |
| `routes/files.ts` | HTTP surface for the vault and git, plus a per-path write lock |
| `watcher.ts` | chokidar watcher over the vault; emits change/remove/tree events |
| `git/index.ts` | simple-git wrapper: status, commit, push |
| `git-broadcast.ts` | Polls git status and broadcasts it to clients |
| `autocommit.ts` | Debounced background commits of vault changes |
| `ws.ts` | WebSocket hub; fans `ServerEvent`s out to connected clients |

Path containment lives in one module and is exercised directly by `tests/server/vault/paths.test.ts`. Every route that accepts a path goes through it — that is the only defence against `../` traversal.

## HTTP surface

| Method | Route | Notes |
|---|---|---|
| POST | `/api/login`, `/api/logout` | Password → signed cookie |
| GET | `/api/health` | Unauthenticated |
| GET | `/api/tree` | Full `VaultEntry` tree |
| GET | `/api/file?path=` | Returns `{ content, mtimeMs }` |
| PUT | `/api/file` | Write; `baseMtimeMs` is an optimistic lock, mismatch → 409 with the disk version |
| POST | `/api/file` | Create |
| POST | `/api/file/rename` | Rename/move |
| DELETE | `/api/file` | Delete |
| GET | `/api/git/status` | Branch, dirty, remote, ahead |
| POST | `/api/git/commit`, `/api/git/push` | Explicit git actions |
| GET | `/api/vault/info` | Vault metadata |
| GET | `/api/config` | Which sign-in this server has. Unauthenticated — it is what tells you how to get a session |
| GET | `/api/github/start`, `/api/github/callback` | Leave for GitHub, and come back |
| POST | `/api/github/token`, `/api/github/signout` | Renew the browser's access token; drop the refresh cookie |
| POST | `/api/share` | Share a note, or extend and replace the one already shared from that path. Needs a GitHub bearer token |
| GET | `/api/shares` | What this account has shared. Needs a token |
| DELETE | `/api/share/:id` | Stop. Only the account that made it |
| GET | `/api/share/:id` | The reader's route, and **the only one that needs nothing at all** |
| GET | `/api/github/app` | The App's install URL, for someone whose installation covers nothing |

Everything above `/api/config` is vault mode only and is **not registered** in github mode. Everything from `/api/config` down is unauthenticated by necessity.

Writes to the same path are serialized server-side by a per-path promise chain in `routes/files.ts`, so read-modify-write races cannot interleave. The map entry is deleted once a chain drains, so idle paths do not accumulate.

## Events

`src/shared/events.ts` is the single contract between server and client:

```ts
type ServerEvent =
  | { type: 'file-changed'; path: string; mtimeMs: number }
  | { type: 'file-removed'; path: string }
  | { type: 'tree-changed' }
  | { type: 'git-status'; dirty: boolean; branch: string; hasRemote: boolean; ahead: number }
```

Events are advisory: the client refetches on receipt rather than applying diffs. That keeps the watcher free of any ordering guarantees it cannot make.

## The vault backend

Everything the web app needs from wherever the notes live goes through one interface, `VaultBackend` in `src/web/api/backend.ts`. `src/web/api/index.ts` exports a `backend` that forwards to whichever implementation is installed — `server-backend.ts` (this server over `/api/*`) or `github/backend.ts` (the user's repository, read and written from the browser). It forwards rather than *being* one of them because which repository is open is not known until someone has signed in and said. Nothing else in `src/web/` calls `fetch`.

The interface is deliberately not the server's own shape, because four of those shapes are facts about a filesystem rather than about a vault:

| The server's | The interface's | Why |
|---|---|---|
| `mtimeMs` as the optimistic lock | `Rev`, an opaque string | A git tree has no mtime; its lock is a blob sha. The app stores a rev and hands it back, and only the backend reads it |
| the same `mtimeMs`, also shown as "Modified" | `modifiedAt`, separate | Two facts that happened to coincide. Not every store's version is a time |
| a `ServerEvent` off a WebSocket the app opens | `backend.connect()` returning a `VaultEvent` stream | The socket is this backend's business. One with no push channel simply never emits |
| `vaultInfo().root`, an absolute path | `info().label` | The status bar wants a name for the vault, not a path on some machine |

Comparing revs is `backend.isSameRev()` rather than `===`: this server's revs are mtimes, and a write's own echo can return a millisecond off.

Signing in is **not** on the interface. It is not a vault operation, and the only other candidate — GitHub — signs in by redirect rather than by request, so `auth` stays a separate export until there is a second one to share a shape with.

The seam exists because of the route in [public-route.md](public-route.md), and it is worth having regardless: each of the four rows above is a place the app previously assumed its vault was a directory on this machine.

## Web state

State is a set of `@preact/signals` modules, not a store framework. Signals are reassigned (`sig.value = next`), never mutated in place.

| Module | Holds |
|---|---|
| `state/vault.ts` | Tree, current path, expansion |
| `state/document.ts` | Content, dirty, base rev, modified time, conflict, save chain |
| `state/git.ts` | Git status and action results |
| `state/settings.ts` | The editor's font size, the view mode and the engine, persisted to `localStorage` |
| `state/ui.ts` | Panel visibility (right panel defaults closed) |
| `theme/useTheme.ts` | Theme choice and the derived `resolvedTheme` |

## Testing

Vitest is split into two projects because the two halves need different environments: `web` (jsdom) and `server` (node). **They must be run separately** — `pnpm vitest run --project web`, then `--project server`. A combined run is unreliable. Playwright drives the real built server (`tests/e2e/server.mjs` seeds a temp vault and `git init`s it) and covers login, file CRUD, save persistence, theme switching, Lapis rendering, and the no-external-requests invariant.
