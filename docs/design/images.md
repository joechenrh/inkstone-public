# Pictures

As built. A picture arrives on the clipboard, from a phone's photo library, or from a camera; it is re-encoded in the browser, stored where the notes are stored, and referred to from the note by a path. Everything else here follows from three constraints, two of which were checked in the code rather than assumed.

## What had to be true

**No CDN, ever.** A hard invariant of this application, asserted by an e2e test. Nothing is uploaded to an image host. The bytes live where the notes live.

**The uncommitted store is `localStorage`.** Chosen so unsaved work survives a closed tab. It holds *strings*, in about 5 MB, and one pasted screenshot would eat the budget the notes are living in.

**Two routes, two kinds of storage.** A vault is files on a server. A GitHub repository is blobs the browser talks to directly, with nothing on the server at all.

## The shape: the bytes never sit in the browser

The instinct is to hold the image with the unsaved text and write it out at save. That cannot work — see the second constraint — and it turns out not to be wanted either. An image is not something you edit. There is no version of it that is half-typed, so there is nothing to keep pending.

```
paste
 │
 ├─ re-encode in the browser (canvas → WebP, longest edge 1600)
 ├─ hash the result (sha-256, first 16 hex)
 ├─ send the bytes to where they belong
 │    github  POST /git/blobs  → a sha, and no commit
 │    vault   POST /api/asset  → a file next to the others
 └─ put a path in the note      ![](/assets/<hash>.webp)
```

`POST /git/blobs` creates an object that no tree and no commit references. One request, invisible in the history, and GitHub garbage-collects a blob nothing ever points at — so a paste that is never committed leaves nothing behind. The working store keeps the path and the sha, about sixty bytes. The commit pressed later adds a tree entry pointing at a sha that is already there, so nothing is uploaded twice.

## Re-encoding, with the numbers

Measured on three screenshots from this project, encoded in a real browser rather than estimated:

| Source | As pasted | WebP 1600 | JPEG 1600 | PNG again |
|---|---|---|---|---|
| crepe4.png · 1564×736 | 136 KB | **9 KB** | 42 KB | 604 KB |
| agent1.png · 3346×1226 | 432 KB | **19 KB** | 37 KB | 539 KB |
| share5.png · 3344×1820 | 581 KB | **35 KB** | 61 KB | 916 KB |

WebP at a longest edge of 1600 and quality 0.82 comes to **4–6% of the original**. JPEG is three to four times worse on screenshots, which are flat colour and hard edges. Re-encoding a PNG as a PNG is *larger than the source every time*, because the canvas throws away whatever the original encoder did — which is why the code never falls back to the source format. If WebP is unavailable, or if the result is somehow bigger than what came in, the original bytes are kept exactly as they are.

This matters more here than in most applications. The repository keeps every version for ever, and the server these notes are read from is on a pay-by-traffic line with a 10 Mbps ceiling.

## Where the file goes, and what it is called

**One `assets/` directory at the vault root.** Not beside each note: this application can move and rename notes, and a per-note folder turns every move into a two-part operation that breaks the note if half of it fails. The cost, stated plainly: a note copied out of the vault on its own loses its pictures. The alternative costs a broken note every time one is moved.

**Root-absolute paths** — `![](/assets/a1b2c3d4….webp)`. The one form that survives a note being moved and that github.com resolves against the repository root.

**Named by the hash of its own bytes**, sixteen hex of sha-256. The design said eight; eight is four bytes, and by the birthday bound ten thousand pictures collide about one time in eighty — which is not a retry, it is the wrong picture in somebody's note, for ever, with no way to notice. The server computes the same digest to the same length, so a vault and the repository behind it call the same picture the same thing. Pasting the same screenshot twice writes nothing the second time; deduplication falls out rather than being a feature.

**Not in the file tree, unless you ask.** `assets/` is storage: nothing opens one, nothing renames one, and a screenshot per paste would push the notes off the screen within a week. That holds while you are writing and fails exactly once — when you want a picture *gone* — so Settings has a **Pictures folder: Hidden / Shown** switch, off by default and remembered. It is a way in rather than a preference, which is what earns it a row.

The hiding is done **in the browser**, not by the server: a tree that dropped the folder could never be asked to show it again. Both routes send it; `FileTree.tsx` decides whether it is drawn.

Two things follow from showing it. A click on a picture opens it in a tab of its own through `assetUrl` — opening one in the editor reads its bytes as UTF-8 and fills the document with mojibake, which is what the hidden folder was protecting you from. And the delete confirmation says **`used in 3 notes`** or **`no note uses it`**, counted against the corpus the search already holds in the browser: no request, no new machinery, and the orphans are what you came to find.

## Showing it is a backend question

The markdown says `/assets/a1b2c3d4….webp`. A browser resolves that against the page, which is wrong in both routes, so `backend.assetUrl(path)` answers it:

| Route | Answer |
|---|---|
| vault | `/api/asset?path=…`, served from disk |
| github, committed | fetch the blob, object URL, cached |
| github, just pasted | the bytes are already in hand |
| share | `/api/share/<id>/asset/<name>`, resolved on the reader's page |

One `MutationObserver` over the document does the rewriting, not a hook per engine — the lesson of the week before this one, where every rendering bug worth the name was a fact about the document written down somewhere only one editor could read.

**Rewriting `src` is safe in both engines, and that was measured.** Crepe renders from a document model and reads nothing back. Vditor's DOM *is* its markdown — but an image in IR mode keeps its path in a `.vditor-ir__marker--link` span beside the `<img>`, and that span is what Lute serialises: a note whose `src` was replaced with a `blob:` URL still saved the original path.

## Caching, which the naming was already for

A note with six screenshots should cost six requests once and nothing ever again. Content-addressed names make that safe rather than hopeful.

| Where | Cache | Why that one |
|---|---|---|
| vault | `private, max-age=31536000, immutable` | A vault sits behind one shared password; `public` would invite every proxy between here and the reader to keep a copy of something that needed a cookie to fetch |
| share | `public, max-age=31536000, immutable` | The page is already public and the bytes are already immutable. The one place a shared cache is doing what it is for — and the one place the 10 Mbps line most needs it |
| github | Cache Storage, keyed by blob sha | The blob is fetched from `api.github.com` with an `Authorization` header, so no URL cache can help |

**Keyed by sha, never by path.** A path is only a name, and the same name can point at different bytes on another branch or after a revert. An entry keyed by sha is true for ever and can never go stale, so nothing needs invalidating — which is the other half of why the hash is in the filename.

Object URLs are held for the life of the note, not the session: `createObjectURL` keeps its blob alive until revoked, and a reader who visits forty notes should not be carrying forty of them. `backend.releaseAssets()` is called when the open note changes.

## Getting it into the document

Each engine reaches the same pipeline by a different route, because each has a different way of being wrong about it.

**Vditor** has `upload.handler`, which is the hook that exists for this. With one configured it stops before its fallback — and that fallback is a base64 data URL inlined into the markdown.

**Crepe** needed the event taken in the capture phase, before ProseMirror sees it. Its `uploadConfig.uploader` must answer with a `src` **string**, and with none configured it answers `URL.createObjectURL(file)`: the first paste into that editor wrote `![](blob:http://…/6f378a6a…)` into the file — a link to a byte range in a tab that has since closed. Plugin order cannot fix it, because Crepe's builder registers the uploader ahead of anything `use()` adds and the first handler to answer wins.

**Crepe's block image feature is off.** Its serialiser is literally `alt: Number.parseFloat(node.attrs.ratio).toFixed(2)` — it writes the aspect ratio into the alt text, so every picture in a note opened there came back as `![1.00](…)`, whatever its alt had been. What is left is the commonmark image node, which round-trips.

## Clicking one

A click on a picture answers with its own markdown, alt text selected, and it goes back to being a
picture when the selection leaves — Typora's behaviour, and the previous engine's. Before this it
answered with a blue box: no address to read, no way to edit it, and no way to delete the picture by
deleting its syntax, which is how anyone who writes markdown deletes one.

**The picture stays on screen.** The source line appears above it and the picture below, which is
what Typora and the previous engine both show — the first version replaced the picture with its text,
and clicking a picture made the picture disappear. The one below is a widget decoration rather than a
node, so the document holds the source and only the source: nothing to serialise, nothing to keep in
step. And closing does not touch the selection: setting it beside the picture sent the caret back
there the moment you clicked anywhere else in the note, and took the view with it.

It is the same plugin that already did this for links (`editor/source-reveal.ts`), because it is the
same idea and the same hazard: while one is open the document holds literal `![alt](/assets/…)`, and
a serialiser escapes literal brackets — so nothing may read the document for keeps until it is
closed. The editor closes it before every save and on every blur. A link opens when the caret moves
*into* it; a picture opens when it is clicked, because a picture is an atom with no inside for a
caret to be in. Read mode opens neither.

## What the reader is told

The line under the picture says what was done, because something *was* done: the file in the repository is not the file that was on the clipboard, and silently changing someone's image is not a thing to do quietly.

| State | The line |
|---|---|
| working | `re-encoding…`, or `2 of 3…` |
| kept | `kept · 581 KB → 35 KB · 1600×871` |
| already here | `linked · the same picture is already here · nothing written` |
| too big | `not pasted · 14 MB after re-encoding · the ceiling is 2 MB` |
| not an image | `not pasted · application/pdf is not something a note can show` |
| upload failed | `not pasted · GitHub did not answer · try again` |
| read-only | nothing happens; there is no caret to paste into |

The refusals name the number they refused on. "Too large" without the size is a wall. The line is anchored under the picture, never follows a tall screenshot off the bottom of the window, and goes away with the next keystroke, click or scroll.

## The phone

Two things differ and neither is cosmetic. The clipboard is not the main way in — a photo comes from the library or the camera — so the bottom bar's picture button opens a sheet with three ways, and `<input type="file" accept="image/*" capture>` is the whole implementation of the first two. And the saving is much larger: a phone photo is 4–12 MB and 4000px wide, and the same rule takes it to about 120 KB.

The button is nowhere near the editor, and only the mounted editor knows where the caret is, so `assets/inbox.ts` is the wire between them — an event rather than a signal, because a signal holding "the files being pasted" would have to be cleared afterwards.

## Sharing

A share is a copy: of the text, of the CJK face cut to the text, and of the pictures. The alternative is a link back into a private repository the reader has no account for. They are replaced as a set when the note is re-shared and dropped when it stops, capped at 4 MB per share, and their names are checked rather than sanitised — a name decides a filename and it arrived over the network.

## Deliberately not built

- **Resizing a picture in the note.** Markdown has nowhere to put a width without HTML, and putting HTML in these notes is a decision of its own.
- **Alt text.** The paste writes `![]` with nothing in it, because the application does not know what the picture is and inventing a filename is worse than an honest blank. A caption is a separate feature.
- **Cleaning up unreferenced assets.** Deleting a picture nobody links to is a repository-wide operation with a way to be wrong. It wants its own design and its own confirmation.
