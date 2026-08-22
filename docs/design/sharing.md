# Sharing

A read-only link to one note, at `notes.example.com/share/<id>`. Anyone can read it; only someone signed in can save a copy. Shipped on the `public-route` branch, and off unless the deployment names a directory.

## The thing this changes

The sign-in screen promised *"your notes go from your browser to GitHub, never through this server"*, and sharing stores a copy of a note here. That is not the promise being broken — it is a promise about **private** notes, about the ones nobody chose to publish. Pressing Share is choosing to publish. The sentence gained its clause before the feature shipped: *"— except a note you choose to share."*

What remains is an operations question rather than an architectural one, and it has four parts.

| Cost | What pays it |
|---|---|
| **Abuse.** An endpoint that stores arbitrary text and serves it from your domain is a free host for phishing | Every share carries the GitHub account that made it, so it is attributable, capped per account and revocable. This is the difference between a pastebin and a feature |
| **Storage.** A directory that grows | 64KB per note, 20 shares per account. A thousand shares is a few megabytes |
| **Growing forever.** Shares nobody deletes | They expire in thirty days, and a daily pass collects the ones nobody ever read |
| **Backups.** Something on this machine whose loss a user would notice | Set aside. The note is still in their repository — only the link breaks |

## What is on disk

`SHARE_DIR` holds two files per share and no database, which is the same shape as everything else this server keeps: `<id>.json` for the facts and `<id>.md` for the text. Metadata is indexed in memory at startup, so sharing, extending and the cap check never read the notes; the text is touched only when someone asks for it.

Ids are six characters from an alphabet with no `i`, `l`, `o`, `0` or `1` — 887 million of them, and none that get misread aloud.

**Two clocks, not one.** `expiresAt` is thirty days out and kills the note; `purgeAt` is thirty days after that and kills the record. Deleting an expired share outright would make it indistinguishable from a link that never existed, and those deserve different sentences. The tombstone is a few hundred bytes and it also goes.

## The routes

| | |
|---|---|
| `POST /api/share` | Share a note, or extend and replace the one already shared from this path. Same id, so a link already sent keeps working |
| `GET /api/shares` | What this account has shared. Asked once when the app opens, so the menu can carry the state without a request per row |
| `DELETE /api/share/:id` | Stop. Only the account that made it |
| `GET /api/share/:id` | The reader's route, and **the only one that needs nothing at all** |

**A body-less request must not declare a JSON body.** Fastify parses one for `DELETE` as readily as for `POST`, so `content-type: application/json` with nothing after it is `FST_ERR_CTP_EMPTY_JSON_BODY` — a 400 that `app.ts`'s scrubbing flattens into "bad request" before any route sees it. Stop sharing failed on exactly this for a release, and `app.inject` never reproduced it because it sets no content-type of its own. When a share route misbehaves only in a browser, check the request headers before the handler.

There is no session of this server's own. The browser already holds a GitHub user-to-server token, sends it, and `share/routes.ts` asks `api.github.com` whose it is — cached for five minutes against a hash of the token, never the token. Unreachable GitHub answers 503, not 401: "sign in again" would send someone round a loop that cannot end.

## In the interface

Two menus that already exist gain one item each, and nothing else appears anywhere.

| Menu | Acts on |
|---|---|
| A tree row's `⋯` (both sizes, beside Rename and Delete) | That row's note — the only entry point a desktop needs, since the tree is on screen |
| The phone's top bar `⋯` (beside Outline and History) | The open note, because on a phone the tree is a different screen |

The item is the state: `Share…`, then `Shared · 28 days left`, in the warning colour under three days. That is the entire notification system. There is no share list, no dashboard, no badge, no view counter and no expiry picker.

The panel is the commit panel's shape — a centred modal on a desktop, a bottom sheet on a phone — because a link is a thing you need to see. A toast that has faded cannot be read twice.

**Nothing touches the clipboard until the button is pressed.** The first version copied automatically the moment a link existed, which was wrong twice over: it announced a copy nobody asked for and took the word back two seconds later, and an automatic write is precisely what iOS refuses outside a user gesture — so on a phone it failed every time and dropped the button into its fallback for no reason. A press *is* a gesture. When the clipboard does refuse, the button says `Select`, the link is selected, and nothing says anything, because a failure with an obvious manual fix is not worth a sentence. `Copied` reverts after two seconds, as it does everywhere else: a button stuck on `Copied` reads as disabled, and copying twice is common.

The panel's head and foot are both `--ink-topbar-height`. Left to their contents they came out 57 and 45, and a box whose lid and base disagree looks wrong before anyone can say why.

The button never changes width or colour — only the word. Growing from `Copy` to `Copied` *and* turning green is three changes to say one thing, and it made the panel twitch on every press.

**Stopping reports rather than closing.** Everything it changes is somewhere the sharer cannot see — a menu item behind a panel that is about to shut, and a link in somebody else's hands — so a panel that simply vanished was indistinguishable from a button that did nothing. It now says what happened, including the part that surprises people: the old link tells its holder the share has stopped, and that reaches nobody who already read the note.

**Opening the panel never republishes.** The design record originally had the menu item copy *and* extend in one press. It does not: checking an old link would then silently publish everything written since. `Update & extend` is one control in a panel you are already in, and it says both things it does.

Sharing the open note saves it first if it has unsaved edits. A share is a copy, and the copy people mean is the note they can see.

## The reader's page

**It scrolls, which the app deliberately does not.** `base.css` pins `html`, `body` and `#root` to the viewport with `overflow: hidden` so the three-section shell never scrolls as a whole; inherited here that was two bugs at once — the note could not be scrolled, and the bar under it, laid out while the note was still a skeleton, was pushed outside the clipped area the moment the markdown rendered. `data-page="shared"` on the root is the opt-out.

**The gutter is inside the scroll container, not outside it.** `.vditor-reset` carries `overflow: auto` from Vditor's own stylesheet, which makes it a scroll container — and a scroll container clips. Themes deliberately hang things into the left margin: Lapis pulls its h2 pill 12.5px out so the pill's *text* lines up with h3–h6. With the page's padding on the parent, the scroller's edge sat flush against the text and sliced every one of them off, which is what "the edge is clipped" looked like in Lapis: a pill with its left end cut away. The padding therefore goes on `.vditor-reset` itself — 56px, the editor's own floor, sized for the widest thing any theme paints outside its text; 24px on a phone, which is all Lapis's pill needs and all a 390px screen can spare.

Measuring this needs care: `getBoundingClientRect()` reports where a box *is*, not whether it is painted. A clipped pill still measures 12.5px out. The check that means something is *element.left ≥ scroller.left*.

**Vditor's heading-level markers are then hidden — a choice, not a patch.** With the gutter above, Lapis's `H1` … `H6` render properly in it. Forest's and Tailwind's do not: they are absolutely positioned against a containing block none of them establishes, so where they land depends on the width of whichever ancestor happens to be positioned — placement tuned to the editor's exact layout, which this page is not. Rather than make a reading page depend on that across seven themes: they say what level you are typing, and nothing here is being typed.

A page, not the application: no tree, no bars, no editor. It wears the same document theme, the same lute and the same typography as the editor — `src/web/editor/document.css` is the list both pages import — and it carries *the reader's* appearance settings, because it is their screen.

**The author of a share gets no bar at all.** The page asks `/api/shares` once when someone is signed in; if the id is theirs, the header says `your shared note` and carries `Open in Inkstone`, and nothing appears under the note. Offering to save it would hand them a second copy of something they are reading out of their own repository, and the one thing they came here to do — check it looks right, then leave — belongs at the top where they land. An unanswerable check falls back to treating the link as somebody else's: a wasted press beats a dead end.

For everyone else the bar sits **under** the note rather than over it: someone who never signs in should be able to read to the end without stepping around an advertisement. On a phone it is full width at 44px and scrolls with the note; a fixed bar over a phone-sized note covers a tenth of it.

Every root in `main.tsx` is imported dynamically for this page's sake. It is the only page people who do not use this app ever open, and it has no business downloading an editor. For the same reason it renders with `icon: ''` and its own two i18n strings, which are what Vditor checks before fetching an icon sprite and a language bundle for a toolbar this page does not have.

Saving needs a repository, so it needs a sign-in, so it needs a round trip — `/api/github/start?return=/share/<id>` carries the way back in a cookie, validated as a same-origin path because a redirect target that can be set from outside is an open redirect. **The trip does not perform the save.** It only makes it possible.

The copy lands in `shared/`, never overwriting: a different note with the same name becomes `(2)`, and a note whose text is already there is recognised by that text and reported as already saved. It is an ordinary uncommitted change and nothing enters anyone's repository until they commit it. The copy is theirs — no link back, no update when the original changes, and nothing about who shared it.

## The face a shared note carries

A Chinese note needs a Chinese serif, and the app ships one: the common 3,755 characters, 1.0MB and 1.1MB. That is right for an editor someone opens daily and a browser keeps for a year, and wrong for a link a stranger opens once — **2,106KB of font for a note using 181 distinct characters**, about fifteen seconds on the 1Mbps line this is deployed behind.

So each shared note gets a face cut to its own characters, at share time, stored beside it. **96KB for both weights instead of 2,106KB, with the same outlines.** `src/server/share/font.ts` cuts it; the reading page appends an `@font-face` for the same family, which as the last rule declared wins the match, so the megabyte is never asked for.

Three things make this hold together rather than fall over:

- **It is cut from the snapshot.** A note goes on changing after it is shared; the copy does not. Text and face are written in the same call, so they cannot drift — and re-sharing replaces both or neither.
- **The source is the complete 16MB face**, kept in `assets/fonts/` and never served. The output holds only this note's characters, so cutting from the whole face costs the same as cutting from the subset and covers the rare characters the subset drops. That is the answer to "what if I use a character it doesn't have".
- **The cut range must equal the shipped face's `unicode-range` exactly.** The shipped face advertises that range; a character inside it and outside the cut is one the cut lacks and the shipped one claims, which fetches the megabyte the whole exercise avoids. Fullwidth commas did it on the first attempt.

A note with no Chinese in it gets no face at all, and its reader pays nothing.

## Colours, and one trap

**Any button with a filled background needs its own `:hover` colour.** `base.css` sets `button:hover { color: var(--ink-link) }` at a higher specificity than a single class, so a button whose background *is* the accent loses its label the moment the pointer arrives. The sign-in button carries the same two lines for the same reason. A destructive text button needs one too, or the global rule quietly repaints the one thing its colour is there to say.

Buttons take `--ink-bg` for their text rather than white: in dark themes `--ink-link` is a muted slate, and white on it falls to about 2.6:1 where the ground reverses cleanly to 6:1.

**Do not use `--ink-code-bg` for a field.** It is a code block's colour and some *light* themes make it dark on purpose — Tailwind's light theme sets `#1e293b` — so a link box borrowing it came out dark text on dark. A field is `--ink-bg` inside a `--ink-rule` hairline, which is what the commit message input does. `--ink-sidebar-hover` is the token for a faintly tinted surface.

Everforest's light accent (`#8da101`) gives a solid accent button about 2.8:1 whatever it is used for. That is a property of the theme and it already applies to the sign-in button; it is not something to work around inside one panel.

## What is deliberately absent

No comments, reactions or forks — this is a link to a document. No custom slugs: a chosen id is a name, and names collide and get squatted. No password on a share, which would be a second secret sent through the same channel as the first. No anonymous writes, which is what makes the storage safe to run at all.

And two things worth saying out loud rather than promising away: **stopping a share does not unsend the link** — it breaks it for anyone who has not already read the note — and **the copy is frozen**, so editing the note afterwards changes nothing until it is re-shared.

## Configuration

`SHARE_DIR` turns it on and needs `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` beside it — every share is attributed to the account that made it, and without one this would be an open text host on somebody's domain. Unset, `registerShareRoutes` registers nothing, `/api/config` reports `sharing: false`, and the menu item never appears rather than appearing and leading to a 404.
