# Design Docs

As-built design documentation for Inkstone. These describe how the system works *now*; they are updated when the design changes.

| Doc | Covers |
|---|---|
| [architecture.md](architecture.md) | Process model, module layout, HTTP/WS surface, config |
| [editor.md](editor.md) | Vditor IR integration, asset self-hosting, editor↔state sync |
| [theming.md](theming.md) | Design tokens, light/dark resolution, Lapis content theme |
| [layout.md](layout.md) | Shell grid, floating right drawer, content column |
| [persistence.md](persistence.md) | Manual save, optimistic locking, conflicts, drafts, watcher, git |
| [editor-engine.md](editor-engine.md) | What Vditor costs, what Crepe and CodeMirror 6 cost, and the measurements behind all three. A decision record, not a decision |
| [agent.md](agent.md) | Phase 3 — a local binary that runs an agent backend (codex today), reached from the browser over loopback. Working on the desktop; the relay is designed, not built |
| [images.md](images.md) | Pasting a picture: re-encoding with the numbers, where the bytes go in each route, and why the name is the hash of them |
| [sharing.md](sharing.md) | Read-only share links, the store on disk, and the reader's page — `public-route` only |
| [TODO.md](TODO.md) | Known limits of what is shipped, with the number that says when each one starts to hurt |

**Only on the `public-route` branch:** [public-route.md](public-route.md) — Inkstone opened to other people, each bringing their own GitHub repository. Shipped there and deployed; the invariant below still holds on `main`.

## What 2.5 was

The phase with no feature at its centre: the things that were missing, and the things that were
wrong once they were used rather than looked at.

| | |
|---|---|
| Search | One field, names and text together, run **in the browser**. The first version asked the server per keystroke and had a debounce, a stale-response guard, a loading state and a two-character minimum — four symptoms of the wrong shape, all deleted with it |
| Committing | The Commit button gained a step: the changed files, the diff, and a message box. A written message now shows in the history it was written for |
| The phone | Git reachable at all; the outline and history as sheets; the bottom bar's two controls made peers; a place for a git action to speak, failures included |
| Repair | Keyboard focus was invisible everywhere. A long path wrapped the top bar. The word count was in two places and disagreed. Opening a large note froze for 431ms on a diff nobody used |

Almost all of it was found by using the app rather than reading it, and several of the fixes were
smaller than the mistakes they replaced — `viewMode` replacing two flags that could contradict each
other, one search replacing two, one push button replacing a button and a question.

## The first principle

**The interface must not grow.** Every change is judged first on whether it adds surface, and the default answer to "should we add a control for this" is no. Fix a control rather than adding one beside it; merge two that answer the same question; remove one that only restates what is already visible; give a new capability a home that already exists — a menu, a keystroke, a context — before giving it a button. A dead end is a bug, not a missing button.

This outranks the improvement being proposed. Where a change cannot be made without new chrome, that is worth saying out loud rather than absorbing quietly.

## Principles that each cost a release

The first principle is about what to build. These are about how to be right about it, and every one
of them was learned by being wrong in this repo.

**Fix the cause, not the thing that looks wrong.** Heading markers were sliced against the column
edge, so they were hidden — twice, in two different ways. The actual fault was `.vditor-reset`
carrying `overflow: auto` from Vditor's own stylesheet, which clips *everything* the themes hang
into the left margin: the markers, and Lapis's h2 pill, and anything a future theme adds. One
correct fix replaced two wrong ones. Ask what else the same cause would break, and check that
rather than the reported case alone.

**Measure the painted result, not the computed one.** `getBoundingClientRect()` reports where a box
was laid out, not whether it survived a clip — so a sliced pill measures perfectly. "Nothing is
clipped in any theme at any width" was reported twice while it plainly was. The assertion that
means something is *element.left ≥ scroller.left*.

**Optimise what dominates, and find out which that is first.** A cold load was 22.6MB and two font
files were 17MB of it — 94%. Everything else on that path compressed to about 1.3MB together. Any
amount of clever work on the code would have moved nothing.

**A promise the system cannot keep is a bug, not a nicety.** `immutable, max-age=1y` was correct for
Vite's content-addressed output and false for everything else, and it was kept faithfully: a deploy
could not replace a font, because nothing would ask again for a year. Anything whose bytes may
change belongs in `src/`, where it gets a hash and the promise becomes true.

**Silence is a design choice, and it costs.** `loadShares` fails silently on purpose — a menu saying
`Share…` is not worth an error bar. That judgement still holds, and it also hid a real bug for a
release: every note's menu said `Share…` while the server knew otherwise. A silent fallback needs a
written note saying it is the first place to look when the visible state and the truth disagree.

**Changing *when* something renders changes what has already run.** Drawing the app before the
session finished restoring produced two bugs from one change: a second token refresh raced the
first, and GitHub rotates refresh tokens, so the loser's failure signed the user out; and Preact
runs a child's effects before its parent's, so everything the app needed at mount had to move out
of the parent's effect and into render. Timing changes are behavioural changes and deserve the same
scrutiny.

**A test that cannot make the request the client makes proves nothing.** Eight tests covered the
share routes and passed while Stop sharing had never worked: `app.inject` sets no `content-type`,
and the browser sent one on a body-less DELETE, which Fastify rejects before any route runs. When
something misbehaves only in a browser, reproduce it with the browser's headers before reading the
handler.

**Both ends, or it is not designed.** Every interface decision here is two decisions. A share panel
drawn once for both sizes was wrong for the desktop; the phone sheet that replaced it sprawled to
twice the height it needed by stacking rows that fit side by side.

## Phases

| | |
|---|---|
| Phase 0–1 | The editor, the vault, git, the shell — shipped |
| **Phase 2** | **UX and UI polish.** 2.1 theme switching · 2.2 table editing · 2.3 source mode · 2.4 the phone · 2.5 search, committing, and the phone's rough edges — all shipped |
| **Sharing** | **`0.5.0`.** A read-only link to one note, and a way for a reader to keep a copy — [sharing.md](sharing.md). `public-route` only |
| **Weight** | **`0.5.1`.** The same product, measured and put on a diet: a cold load went 22.6MB to 4.5MB, a shared Chinese note 2,985KB to 973KB, and the two seconds of blank page at startup went to none |
| Phase 3 | Agent integration — a per-user local binary **the browser** talks to, over loopback. Designed in [agent.md](agent.md); the binary, the drawer, the Settings row and the proposal flow work end to end. The relay that lets a phone reach a laptop does not exist yet |

The agent moved out of Phase 2 deliberately: the security note in the README and `architecture.md` (never expose this to the public internet) was written for a server that spawns an agent with write access to the vault.

That note has since been **rewritten rather than dropped**. It still binds vault mode, which is the deployment it was written for. github mode — [public-route.md](public-route.md) — is exempt because it has no vault, no shared password and no per-user state on the server, which is a different thing from the rule being relaxed. Phase 3 under that route is an agent that never runs here at all.

Phase specs and implementation plans (point-in-time records of *how we got here*) live under `docs/superpowers/specs/` and `docs/superpowers/plans/` and are not maintained after their phase ships.
