# Inkstone — Web Typora Design

> The project name `inkstone` is a placeholder and can change at any time. Every `<app>` in this document refers to that name.

## 1. Goals and scope

A web markdown editor deployed on your own server, replicating Typora's WYSIWYG feel, with a built-in conversational assistant backed by the local codex CLI for intelligently creating and modifying notes.

**Explicit use case**: single user, personal use, editing one markdown notes directory (a vault) on the server, with the service listening only on an intranet/Tailscale address and never on the public internet.

**Explicitly excluded** (out of scope for this spec): multiple users, real-time collaboration, visual table editing, typewriter/focus mode, switching between vaults, mobile adaptation, server-side PDF generation.

## 2. Settled key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Editor core | CodeMirror 6 hybrid live preview | The bytes on disk are the source you see, with zero-loss round trips and Obsidian vault compatibility; a ProseMirror approach would reformat the user's original text on serialization |
| Backend | Node + TypeScript (Fastify) | Same language and types as the frontend, so markdown parsing logic can be shared |
| Frontend framework | Preact + signals | Application state is simple; React's bulk is unnecessary |
| Transport | REST (request/response) + a single WebSocket (server push) | The codex event stream and file-change notifications share one connection, so the client needs only one reconnect state machine |
| Codex integration | A same-machine `codex exec --json` subprocess | It can genuinely read and write files, grep existing notes, and run multi-turn agent loops |
| Auth | A shared password from an environment variable + a signed cookie | Single-user personal use; no account system |
| Network exposure | Intranet/Tailscale interface only | The backend spawns an agent with file write permissions; public exposure is an unacceptable risk |
| Saving | Autosave (1s debounce) + the vault is a git repository | If codex gets something wrong it can be diffed and rolled back |

### 2.1 Layering of saving and committing

Autosave and git commit are two different things at two different frequencies, and must not be conflated:

| Action | Trigger | Notes |
|---|---|---|
| Persist to disk | 1s after typing stops | Writes the file only, never touches git. This is the primary defence against data loss |
| Periodic commit | When more than 5 minutes have passed since the last commit and the working tree has changes, fired after the next disk write | Message `autosave: <truncated list of relative paths>`. Avoids one commit per keystroke |
| Pre-turn commit | Before a codex turn starts, if the working tree has changes | Message `wip: before codex turn` |
| Post-turn commit | After a codex turn ends, if the working tree has changes | Message taken from the turn's first user message |

Every commit uses `git add -A` across the whole vault, because codex may have changed multiple files.
| Export | Self-contained HTML (print to PDF from the browser) | Avoids pulling in a ~300MB Puppeteer dependency |

## 3. System architecture

A single-process Node/TS service, started by systemd. The Vite-built frontend assets are served by the same process, so there is no cross-origin.

### 3.1 Backend modules

The dependency direction is strictly one-way: `server` depends on the other five modules, and those five do not depend on each other.

| Module | Responsibility | Key constraint |
|---|---|---|
| `vault` | The only layer that touches the filesystem: path resolution, read/write, directory tree, rename, delete, image persistence | Every externally supplied path must go through `resolveSafe()`; this is the single gate against path traversal |
| `git` | Snapshots and rollback: commit, diff, restore | Consumes only the root path constant exposed by `vault`; never builds paths itself |
| `watcher` | chokidar watches for external changes and emits events after debouncing | Must filter out the files it just wrote itself, to avoid a self-triggering loop |
| `codex` | Orchestrates the `codex exec --json` subprocess, parses JSONL, manages thread_id and resume | Process lifetime is decoupled from the HTTP request; the codex executable path is injectable (for testing) |
| `search` | Calls ripgrep for full-text search, returning matching lines with context | Read-only |
| `server` | Fastify routes + auth middleware + WebSocket hub | Contains no business logic; only orchestration and serialization |

Both `vault` and `codex` can be tested independently of the HTTP layer.

### 3.2 Frontend modules

| Module | Responsibility |
|---|---|
| `editor` | CodeMirror 6 core configuration + the live-preview extension set |
| `filetree` | The left-hand directory tree; create/rename/delete |
| `outline` | Heading outline navigation |
| `chat` | The Codex conversation sidebar |
| `search` | The global search panel |
| `api` | REST client + WebSocket reconnect state machine |
| `theme` | The CSS variable layer, with light and dark themes |

### 3.3 Handling externally changed files

When codex changes a file it triggers the watcher, and blindly reloading the editor would swallow whatever the user is typing. The rules:

- Changed file ≠ the open file → silently refresh the file tree
- Changed file = the open file, and the editor has no unsaved changes → reload automatically
- Changed file = the open file, and there are unsaved changes → a non-blocking bar at the top where the user picks "use the disk version" or "keep mine"

## 4. Live preview mechanism

The foundation is `@codemirror/lang-markdown` (Lezer incremental parsing). Every rendering is a decoration derived from the syntax tree plus the cursor position; the document itself is always raw markdown.

### 4.1 Two layers (a hard CodeMirror 6 constraint)

In CM6 only decorations from a `StateField` can change block structure (replacing across lines, inserting widgets with height); `ViewPlugin` decorations run after viewport measurement and cannot replace across lines.

- **Block layer (StateField)**: `$$...$$` math blocks, Mermaid code blocks, images on a line of their own, horizontal rules, tables. The whole block is replaced by a widget.
- **Inline layer (ViewPlugin)**: bold, italic, inline code, links, strikethrough, inline math, heading `#` markers. Only hides the marker characters and attaches CSS classes, handling only the lines in the viewport.

### 4.2 Cursor reveal rule

Both layers share one predicate: if the selection overlaps the node's character range, skip that node's decoration.

- Inline nodes are decided per node: a cursor inside one `**bold**` reveals only that one
- Block widgets are decided per block: a cursor anywhere inside a `$$` block turns the whole block back into source

`atomicRanges` must be registered alongside, or arrow keys will step character by character into the hidden markers and the cursor will appear stuck.

### 4.3 Asynchronous rendering

KaTeX is synchronous and needs no special handling. Mermaid is asynchronous and expensive; left alone it would re-render the whole diagram on every keystroke.

- Widgets are cached keyed by their source string; `eq()` treats identical source as reusable DOM and skips the re-render entirely
- While a render is in flight, the previous height is kept as a placeholder, so the page does not jump and the scroll position does not scramble when it completes

### 4.4 Tables (an MVP trade-off)

Typora's click-a-cell-and-edit would, in hybrid mode, require a controlled sub-editor inside the widget and translating every cell edit back into a precise range replacement in the source — roughly as much work as all the other live-preview extensions combined.

**MVP implementation**: source mode + column alignment colouring + Tab to move between cells + auto-completing the separator row. Visual table editing is deferred to a separate project.

### 4.5 Input feel

Each is a separate CM6 `keymap` or `inputHandler`, implemented and tested one at a time:

- Enter continues a list and recognizes ordered numbering
- Enter on an empty list item exits the list
- Tab / Shift-Tab adjust list nesting
- `**`, `` ` ``, and `$` auto-pair
- Pasting a URL over selected text turns it into a link
- `- `, `> `, and `# ` trigger at the start of a line

## 5. Codex integration

### 5.1 Process model

One conversation turn = one subprocess.

- First turn: `codex exec --json -s workspace-write -C <vault root>`, taking `thread_id` from the `thread.started` event and persisting it
- Later turns: `codex exec resume <thread_id> --json`

Conversation context is maintained by codex itself in `~/.codex/sessions`, so the server never replays history. The process exits at the end of a turn, and a service restart does not prevent the session from being resumed.

**A verified pitfall**: when stdin is a pipe, codex blocks waiting for input and prints `Reading additional input from stdin...`. On spawn, the prompt must be written to stdin followed by an explicit `end()`, or passed as argv with stdin set to `ignore`.

### 5.2 Sandbox boundary

Uses `-s workspace-write`, which locks write permission to inside the vault directory, with the network off by default.

**Do not use** `--dangerously-bypass-approvals-and-sandbox`. Exec mode has no human approval step, so the sandbox is the only line of defence — which is also the direct reason the service never goes on the public internet.

### 5.3 Event protocol

Verified event format (codex-cli 0.146.0):

```jsonl
{"type":"thread.started","thread_id":"019fe690-8830-7d72-a8bf-f5a987c5ccc7"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":15656,"cached_input_tokens":11008,"output_tokens":5}}
```

The backend parses the JSONL line by line and forwards it verbatim over the WebSocket; the frontend dispatches rendering by `item.type`:

| item.type | Rendering |
|---|---|
| `agent_message` | A message bubble |
| `reasoning` | Collapsed into one line of grey text |
| `command_execution` | An expandable command block |
| `file_change` | Filename + number of changed lines |
| Unknown type | Degrades to a single line, "codex ran X" |

Degrading unknown types is a hard requirement: the codex CLI version will evolve and event types will be added, and the frontend must not break because of it.

### 5.4 Context injection

Before sending, the frontend composes a preamble from "the path of the currently open file" and "the selected text (if any)" and prepends it to the user's message.

No vector retrieval — codex greps the vault itself, and does it better than anything we would build.

### 5.5 Concurrency and cancellation

- Only one turn may run per session at a time; a second send is simply disabled in the UI
- Cancelling means sending SIGTERM to the subprocess; the turn is marked "interrupted" and the session can still be resumed

### 5.6 Interface with git

- Before a turn starts: persist the editor's unsaved content and commit, with the message `wip: before codex turn`
- After a turn ends: commit codex's changes, with the message taken from the turn's first user message
- At the end of a turn the sidebar shows the list of files changed in that turn, with diffs viewable, and a "roll back this turn" button that runs `git revert` on the corresponding commit

### 5.7 Chat history persistence

Codex's session files are not suitable for driving the UI directly. The server keeps its own lightweight record at `~/.local/share/<app>/chats/<id>.json`: `thread_id`, title, message list, and the commit hash for each turn.

The storage location is outside the vault, so it does not pollute the notes directory.

## 6. Visual design

Typora's minimalism is a handful of concrete typographic rules. Abstract them into a CSS variable layer, and the light and dark themes differ only in the variable values.

### 6.1 Typographic skeleton

Aligned with measured values from Typora's default GitHub theme:

- Editor content is `max-width: 860px` centered, `padding: 30px 30px 100px` (the bottom whitespace lets the last line scroll to mid-screen)
- Body text 16px / `line-height: 1.6`, with paragraph spacing from `margin` rather than blank lines
- Font stack `"Open Sans", "Helvetica Neue", "PingFang SC", "Noto Sans CJK SC", sans-serif` — the CJK fallback must be declared explicitly
- h1/h2 carry a 1px hairline underneath, h3 and below do not; heading top margins are noticeably larger than bottom margins

### 6.2 Palette

| Variable | Light | Dark (Typora Night) |
|---|---|---|
| Background | `#ffffff` | `#363B40` |
| Body text | `#333333` | `#B8BFC6` |
| Links | `#4183C4` | `#7BA6C9` |
| Code block background | `#f8f8f8` | `#2E3033` |
| Quote line / rule | `#dfe2e5` | `#4B5054` |
| Sidebar background | `#fafafa` | `#31353A` |

### 6.3 Three disciplines

No rounded corners (except 3px on code blocks), no shadows (except popup menus), no borders as separators (use background contrast). Typora's "clean" comes from these three.

### 6.4 Layout

```
┌──────────────────────────────────────────────────────┐
│ Narrow top bar 32px: breadcrumb · save state ·       │
│                      theme · sidebar toggle          │
├─────────┬──────────────────────────┬─────────────────┤
│ File    │   Editor (860px,         │  Outline /      │
│ tree    │   centered)              │  Codex          │
│ 260px   │                          │  320px          │
│         │                          │  (tabbed)       │
├─────────┴──────────────────────────┴─────────────────┤
│ Status bar 24px: words · characters · git state      │
└──────────────────────────────────────────────────────┘
```

The right-hand column is shared by two tabs, "Outline" and "Codex", with only one visible at a time. Both side panels can be collapsed; with everything collapsed it is a pure writing surface. Shortcuts: `Cmd/Ctrl+\` collapses the left panel, `Cmd/Ctrl+/` the right.

## 7. Error handling

The principle: never fail silently. This is a notes application, and losing text is worse than crashing.

| Failure | Handling |
|---|---|
| Path traversal attempt | `vault.resolveSafe()` calls `realpath` first and then asserts the result is still inside the root (string normalization cannot stop a symlink); reject and log |
| Save failure (disk full / permissions) | A persistent red bar at the top, with the content also written to localStorage as a fallback so it survives a refresh |
| codex not installed or not logged in | The service self-checks `codex --version` and auth state at startup; on failure the Codex tab shows explicit guidance rather than a blank spinner |
| codex process exits non-zero | The tail of stderr is shown in the chat stream, the turn is marked failed, and the session can still be resumed |
| WebSocket disconnect | Exponential backoff reconnect; after reconnecting, fetch full state once (the current file's mtime, whether a turn is running) |
| git operation failure (lock, conflict) | Does not block editing; only turns red in the status bar |
| Very large files (>2MB) | Refuse to enable live preview, degrade to plain source mode and say why |

## 8. Test strategy

TDD: tests first.

| Target | Method |
|---|---|
| `vault` | Path traversal is the focus: `../`, absolute paths, symlink escapes, URL encoding, double encoding — one case each. A bug in this module is directly equivalent to leaking server files |
| `codex` | The codex executable path is injectable, replaced in tests by a shell script that emits pre-recorded JSONL. Covers four cases: a normal turn, a mid-turn crash, an unknown `item.type`, and the process being killed. Never hits the real API |
| CM6 extensions | One unit test per live-preview extension: construct a document + cursor position and assert the resulting decoration set. `EditorState` is a pure data structure, so no browser is needed |
| End to end | A small Playwright smoke: open a file, edit, wait for autosave, refresh, the content is still there |

## 9. Export

Generating PDFs server-side needs Puppeteer (~300MB plus system libraries), which is not worth it for a personal tool.

**The approach**: export self-contained HTML — KaTeX and Mermaid are pre-rendered to static SVG on the server, CSS is inlined, images become data URIs, and the output is a single file. When a PDF is needed, `Cmd+P` in the browser produces a layout identical to Typora's export. One fewer heavy dependency, and one more artifact you can send someone directly.

## 10. Delivery phases

| Phase | Contents | State on completion |
|---|---|---|
| 0 | Fastify + `vault` + auth + frontend shell + file tree + plain-source CM6 + autosave + git commit | A usable server-hosted markdown editor |
| 1 | Live preview: inline layer, block layer, KaTeX, Mermaid, images, input feel | Has Typora's core feel |
| 2 | Codex sidebar: process orchestration, WS event stream, chat UI, per-turn git snapshots and rollback | Intelligent note creation is usable |
| 3 | Global search, outline panel, HTML export, light/dark theme switching | MVP complete |

Phase 1 is roughly as much work as the other three combined.

## 11. Deployment

- Build output: the `dist/` directory (backend JS + frontend static assets)
- Run: `node dist/server.js`, managed by systemd
- Configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `VAULT_ROOT` | none (required) | Notes root directory; must be a git repository |
| `AUTH_PASSWORD` | none (required) | Login password |
| `SESSION_SECRET` | none (required) | Cookie signing key, independent of the password — otherwise changing the password would not invalidate sessions, and leaking the password would be equivalent to being able to forge one |
| `LISTEN_ADDR` | `127.0.0.1` | Bind address. Must **not** default to `0.0.0.0`; set it to the Tailscale interface address when deploying |
| `PORT` | `7654` | Listen port |
| `CODEX_BIN` | `codex` | Path to the codex executable; a stub is injected in tests |
- Prerequisites: the server has the codex CLI installed and logged in, has ripgrep installed, and the vault directory has been `git init`ed
