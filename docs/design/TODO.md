# Known limits

Things that work now and will not keep working, with the number that says when. Kept here rather
than in commit messages so the next person to touch one of these does not have to rediscover why it
was left.

This is not a wish list. Nothing goes here unless it is a real limit of something already shipped.

## Search reads the whole vault into the browser

Search fetches every note's markdown once (`/api/corpus`) and scans it in memory. This replaced a
per-keystroke server search, which is what made it feel slow — the reasoning is in
[layout.md](layout.md#search) and the constraint is real: local data is why VS Code and Typora do
not stutter.

Measured when it shipped: **the vault was 2,271 bytes across 3 notes, 1,220 gzipped.** Every limit
below is comfortable at that size and none of them is comfortable forever.

| Limit | Where it starts to hurt | What to do about it |
|---|---|---|
| The whole corpus is fetched before the first search can answer | The "Loading the vault…" pause becomes noticeable somewhere around **2–3MB** over a slow link | Fetch in the background after login instead of on first use, so the pause lands where nobody is waiting |
| Every keystroke scans every byte | A single scan is O(total bytes); at **~10MB** this stops being free on a phone | An index — trigram or inverted — built once when the corpus loads. Only worth it after the fetch itself is solved, since it makes the load slower |
| The corpus is held in memory in full | Phone memory, somewhere past **20–30MB** | Stop shipping the text: send an index built on the server and fetch matching notes on demand |
| Any save or tree change drops the whole copy and refetches it | Every save costs a full refetch once the corpus is large enough to notice | Patch the one changed note in place. Deliberately not done yet: it is a second source of truth, and wrong results are worse than a slow refetch |
| Unsaved text is not searched | Always true, and invisible until it bites — you cannot find a word you just typed and have not saved | Search `content.value` for the open path alongside the corpus |
| One hit per note, in vault order | A note that mentions a term twenty times looks like it mentions it once; a note edited today ranks below one from a year ago | Rank by recency and hit count, and show the top few hits per note |
| Literal matching only | No whole-word, no case sensitivity, no regex | Add them as they are actually missed, not before — each is a control, and the interface must not grow |

### What the flashing was actually about

Worth writing down because it will matter again when this design hits its ceiling: **grep over SSH
on the same server has none of these problems.** Same machine, same files, same network — at worst
the answer takes a moment longer to appear. It never flashes, never empties, never contradicts
itself.

So the network was never the fault. `grep` is a **one-shot command**: asked once, answered once,
and the answer stays. What we built was a *stateful, cancellable, per-keystroke* thing out of
something that is fundamentally one-shot, and every symptom came from that state machine — a new
query clearing the previous answer, a stale response arriving after a newer one, a minimum length
invented to throttle it.

Moving search into the browser fixed it by removing the state machine, not by removing the network.
**If any of the limits below force a server search back, the lesson is the shape rather than the
transport**: answer the query that was asked, never clear a good answer to make room for a pending
one, and let a slow answer be slow rather than making the list flicker while it waits.

The honest summary: **this design is right for a personal vault and wrong for a large one**, and it
has no gradual failure — it works, and then the first search takes a second, and then it does not
fit. The 8MB total and 512KB per-note caps exist so the failure is a message rather than a hang.

## Table editing rewrites the rendered DOM

Table operations edit the rendered table and dispatch `input`, because Vditor's own functions are
module-internal (see [editor.md](editor.md#editing-tables)). That works, and it means every table
operation depends on Vditor's DOM shape rather than on a documented API. A Vditor upgrade can break
it silently — the e2e tests are the only thing that would say so.

## The phone layout is emulated in tests, not tested on a phone

`tests/e2e/mobile.spec.ts` runs a 390px touch viewport on Chromium, because spreading
`devices['iPhone 13']` switches the browser to WebKit and WebKit is not installed. The layout and
the touch affordances are the app's rather than the engine's, but iOS Safari's soft keyboard and
`dvh` handling are exactly where emulation is weakest. A real Safari pass is still a manual step.

## A shared note downloads a 4MB markdown renderer

`/share/<id>` renders with `Vditor.preview`, which fetches `lute.min.js` — **4,000,699 bytes, about
680KB gzipped** — so the note reads exactly as it does in the editor. The editor pays the same
cost, but it is opened by one person who then keeps the tab; a share link is opened by strangers,
once, often on a phone. It is now **90% of what that page fetches**, everything else having been
cut.

`index.html` preloads it, which buys the three round trips it used to spend waiting to be asked for
— but not the bytes.

**When it starts to hurt:** it already does on a slow link. The server this is deployed to serves
about 16KB/s to the public internet, which makes lute alone a forty-second wait.

The fix that would actually remove it: render the markdown to HTML **in the sharer's browser**,
which already has lute loaded, and store that beside the note. Readers would then need no parser at
all and the fidelity would be exact, being the same renderer. It is not done because it makes the
server store and serve client-authored HTML, which is a different security question from storing
markdown, and one worth answering deliberately rather than in passing.

The cheap half is that lute is cached for a year after the first visit, so a second shared note from
the same reader is instant. The expensive half is the first one, and the only real fixes are a
smaller renderer for the reading page — which means the reader and the writer no longer see the same
output, and that fidelity is the whole reason the page borrows the editor's themes — or rendering to
HTML at share time and storing that, which doubles what the store holds and freezes the rendering at
the version that made it.

## The reading page still fetches a 4MB parser

With the fonts cut per note, `lute.min.js` is what is left: 684KB gzipped, about 78% of what a
shared note now costs. See the entry above for the fix and why it has not been taken.

## Shared notes are not backed up

`SHARE_DIR` is the one directory on the server whose loss a user would notice, and nothing copies it.
Accepted deliberately: the note itself is still in its author's repository, so losing the store
breaks links rather than notes, and every share expires within thirty days anyway.

**When it starts to hurt:** when someone treats a share link as the canonical address of something —
which the thirty-day expiry is already designed to discourage.
