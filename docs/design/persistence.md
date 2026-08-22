# Persistence and Sync

Four mechanisms keep the browser, the disk, and git in agreement: manual save with an optimistic lock, local drafts, a filesystem watcher, and explicit git actions.

## Manual save only

Autosave was removed in Phase 0.5. Saving is Ctrl+S, and an unsaved document shows a dot in the breadcrumb and in its file-tree row.

The reason is git. A vault that autosaves produces a commit stream of half-finished sentences; a vault that saves on an explicit keystroke produces commits that correspond to moments the author considered done. The dot exists so "unsaved" is never ambiguous — with no autosave, the user is responsible for the transition, so it has to be visible.

## Optimistic locking

`GET /api/file` returns `{ content, mtimeMs }`. The client keeps that `mtimeMs` as `baseMtimeMs` and sends it back with every `PUT`. If the file's mtime on disk no longer matches, the server returns **409 with the current disk content**, and the client raises a conflict instead of overwriting.

The 409 body carries the disk version so the resolution UI needs no second request, and so the decision is made against the bytes that actually caused the conflict rather than a later re-read.

Resolution is a choice, never a merge: keep the editor's version (rebase onto the new mtime and save again) or take the disk version (replace the buffer). Auto-merging markdown silently is worse than asking.

## Serialized saves

`flushSave()` in `src/web/state/document.ts` chains every call onto the previous one:

```ts
let saveChain: Promise<void> | null = null

export function flushSave(): Promise<void> {
  const prev = saveChain
  const run = prev ? prev.then(doFlushSave, doFlushSave) : doFlushSave()
  saveChain = run
  void run.finally(() => { if (saveChain === run) saveChain = null })
  return run
}
```

Concurrent saves are a correctness bug, not merely wasteful: two in-flight writes both carry the same `baseMtimeMs`, the server serializes them, and the second one finds an mtime the *first one* just changed — a self-inflicted 409 that reports "the file has changed on disk" on every save. Serialized, the second call sees `dirty === false` and returns immediately.

When idle, `doFlushSave` starts synchronously so callers keep their existing "the save has begun" timing. Both arguments to `.then` are the same function: `doFlushSave` already swallows its own errors, and the redundancy guarantees one exception can never wedge the chain permanently.

The save snapshots `content` before the request and only clears `dirty` if the value is unchanged on return — text typed during a save stays dirty rather than being marked clean and lost.

## Drafts

Every edit mirrors the buffer to `localStorage` under `inkstone.draft:<path>`. On open, a draft that differs from the disk content wins, and the document opens dirty.

This covers the gap the manual-save decision creates: a closed tab or a crash between edits and Ctrl+S would otherwise lose work. The draft is removed on a successful save and on close. A failed `localStorage` write is swallowed — a full or blocked storage must never block typing.

## Watcher

`src/server/watcher.ts` runs chokidar over the vault and emits `file-changed`, `file-removed`, and `tree-changed` over the WebSocket. That is how edits made by an agent, by git operations, or by another editor reach the browser.

It carries one platform workaround. On macOS, chokidar's fsevents backend replays spurious change events for existing files shortly after startup, at a very high rate. During a startup grace period the watcher therefore drops events whose stat'd `mtimeMs` exactly equals the recorded baseline. The dedup is deliberately narrow — exact-match only, never more aggressive over time, and off entirely once the grace period ends — because a real second write that happens to land on the same low-precision mtime tick must not be swallowed. The optimistic lock is the backstop if one ever is.

`tests/server/watcher.test.ts` exercises this with real timers and is the most timing-sensitive test in the suite; it is the usual suspect behind a "timed out waiting for condition" failure under parallel load.

## Server-side write locking

`routes/files.ts` keeps a per-path promise chain so two writes to the same path can never interleave. Each entry is deleted once its chain drains, so idle paths do not accumulate. This is independent of the client-side chain: it protects against multiple tabs and against anything else writing concurrently with the browser.

## Git

The vault is a git repository, which is the backup, the history, and the sync mechanism all at once — no separate versioning layer needs to exist.

- `autocommit.ts` commits vault changes on a debounce, so history accrues without ceremony.
- `git-broadcast.ts` polls status and pushes `git-status` events (branch, dirty, has-remote, ahead) to the status bar.
- Commit and push are also available as explicit actions; push is behind a confirmation step, since it is the one operation that leaves the machine.

## Committing

The Commit button opens a panel rather than committing: the changed files with their insert and
delete counts, the diff of whichever is selected, a message box, and Commit / Commit & push. It is
the same button with a step in front of it — no permanent chrome was added on either end.

It exists because the log read as a list of nothing. Commit fired immediately with a generated
message, so every entry said `vault: 3 files` and the history panel showed the time instead, having
nothing better to show. Now that a message can be written, a written one is displayed there and the
generated ones are still filtered out (`isGenerated` in `sessions.ts`) — the panel shows what a
person said, or the time, never the machine's own text.

An empty message box still means the generated message, so committing without thinking is one
press. The box exists so writing something real is possible, not compulsory.

**The bottom row is the message field and nothing else.** It carried a Commit button and a
"Commit & push" beside it — two controls of equal weight for one action and one modifier, and a
second way to push when the status bar already has one with its own confirmation. Push stays where
push lives. Enter commits, Escape cancels. A button does come back under a coarse pointer: a hint
naming the return key is what this app stopped doing on touch, and a panel with no visible way to
finish is a dead end there.

**The changes are fetched before the panel opens.** Opening first and loading into it showed a
111px panel saying "Reading the changes…" that jumped to 323px of content — a flash on every press.
The button carries the wait instead, which is where the press happened.

The message field is focused explicitly. `autoFocus` does nothing on anything mounted after load,
since the document's autofocus flag is spent by the login form — the third place in this app where
that has bitten, and here it meant Enter, the only way to commit on a desktop, did nothing.

Git's own file header is stripped from each diff. `diff --git`, `index`, `---` and `+++` repeat the
filename already shown above the diff, and git writes non-ASCII paths in them octal-escaped, so a
note called `测试文件.md` arrived as `"a/\346\265\213..."` and was the first thing on screen. The
`@@` markers stay: they say where in the file you are, which the header never did.

`/api/git/changes` answers "what is about to be committed", which nothing could before:
`/api/git/diff` is per-file and per-commit. Each file is diffed against HEAD separately, so a
rename or an unreadable path costs that file's diff rather than the whole answer, and an untracked
file — which has no HEAD side — has its contents read and shown as all-added, because a brand new
note appearing as a name with nothing behind it is exactly when you most want to look.

On a phone the same panel is a sheet, reached from the ⋯ menu. **Git was previously unreachable
there entirely**: the bottom bar is the view control and Save, and the desktop's git footer is not
rendered on a phone at all.

When the vault is clean the button is disabled, which says "nothing to do" more cheaply than a
panel that opens to say it. The panel's own "nothing to commit" note is for the phone, where the
menu item is not disabled, and for the case where the vault goes clean between opening and reading.

## Pushing

One control. It said what it would do and how much — "Push 10" — and then asked again in running
text inside the status bar: a question, an answer and a second answer, with `commit(s)` standing in
for a sentence nobody wanted to write twice, and the word counts shifting sideways to make room.

Push is additive and outward-only: it sends commits that already exist to a remote that already
exists. Nothing is lost if it happens by accident, and a second click guards against nothing that a
first one aimed at a button reading "Push 10" did not already mean. So the button is the
confirmation, and pressing it pushes.

**The state is a colour, not a shape.** The label goes from the accent to muted while it works,
rather than the bar growing a new element — nothing moves at the moment you are looking at it, which
is what the old confirmation did to the word counts beside it.

On a phone push is its own item in the ⋯ menu, on the same condition: a remote exists and something
is ahead of it. It names how much it will send, so it is never offered when it would do nothing.

## Empty, or not yet known

An empty state is an assertion — *there is nothing here* — and it must not be made before anyone has looked. Two screens were making it:

- `tree` was `signal<VaultEntry[]>([])`, and `[]` meant both "this vault has no notes" and "nobody has fetched them", so **"No notes yet" was on screen for every load**. It is `VaultEntry[] | null` now; null is "not yet" and only an actual empty array claims the vault is empty.
- `openFile` awaited the read *before* setting `currentPath`, so between a tap and the text the app believed no file was open and the editor column said so. The path is claimed first now, `loadingPath` says the body is still coming, and a failed read puts the path back and reports through the existing error bar. A read that lands after the user has asked for something else is dropped rather than overwriting what is on screen.

Measured before the change and after, by clicking and reloading at three latencies:

| | Before | After |
|---|---|---|
| "No notes yet" on a 200ms link | 178ms | never shown |
| "No notes yet" on a 500ms link | 478ms | never shown |
| "No file open" on a 200ms link | 221ms | never shown |
| "No file open" on a 500ms link | 546ms | never shown |

**Two thresholds keep a fast load from flickering**, both in `usePendingPlaceholder`: nothing is drawn for the first 180ms, and once a placeholder appears it stays at least 300ms. On a local disk — 21ms for the tree, 37ms to open a note — no placeholder is ever drawn at all; past 200ms of latency both appear and stay. Neither number is there to announce a wait; they exist to prevent a flash.

The placeholders are skeletons in the shape of what replaces them — indented rows for the tree, a centred heading and three lines for a note — rather than spinners. A spinner says something is happening somewhere; this says what is coming and where. Both stop moving under `prefers-reduced-motion`.
