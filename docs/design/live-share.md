# Live share

A link to one note that other people **edit with you**, without signing in, at
`notes.example.com/live/<id>`. Off unless the deployment sets `INKSTONE_LIVE=1`.

Sharing (`sharing.md`) publishes a copy and is read-only. This is the live note, and the difference
is not a feature flag — it is a socket anybody holding the link may write through, which is a
different thing to be running.

## What was asked for, and what it cost

> 我分享一个文档，其他用户也可以一起编辑（无需登陆） … 实时协作开启的时候可以先暂停 git 更新该文档。
> 或者其他途径也可以，**协作是第一优先级**。

A session, not a standing document: the owner is present, the link lives as long as the sitting
does. Two decisions follow from "collaboration first", and both are losses taken deliberately.

**The reveal plugins are off during a session.** `mark-reveal.ts` and `source-reveal.ts` put the
note's own markdown *into the document* — `**bold**` while the caret is in it, `[a](b)` while it is
in a link — and that is what makes this editor feel like markdown rather than like a word processor.
In a shared document that text is shared: every marker a caret opened would appear and disappear on
everybody else's screen, and two carets in overlapping runs would fight over the same characters.
So a live session trades them away. The editor is **rebuilt** when a session starts or stops, because
a Milkdown editor takes its plugins while it is being built; `App.tsx` gives it a `key` that changes
with the session, which is what makes that happen.

**This note does not save or commit for the duration.** `state/suspend.ts` holds both. Holding the
commit alone was not enough: on a vault deployment a save is a write to the file, the autosave timer
wrote on every pause, and a write whose base revision the previous write had just moved came back as
"the file has changed on disk" — about the reader's own text. The draft stays in local storage the
way it does for any unsaved note, and the session ends with one write and one commit.

## The shape

Yjs, through Milkdown's own `@milkdown/plugin-collab` — pinned to the editor's version, because
`@milkdown/ctx` 7.22.1 and 7.22.3 are not the same type and the mismatch is a compile error, not a
runtime surprise. The alternative considered was `prosemirror-collab`: a smaller bundle, but remote
carets would be ours to write and the server would need either a ProseMirror schema or a step log
plus client snapshots. Both of those are code we would own and get wrong.

**The server cannot read the document, and that is the point.** It merges opaque Yjs updates and
relays them (`live/protocol.ts`), so there is no ProseMirror schema in Node and no Milkdown on the
server. The consequence worth knowing: this server *cannot* turn a session into markdown. Only a
browser with the editor in it can, which is why the owner saves — and why a dropped session is
**kept** rather than written out.

| | |
|---|---|
| `live/store.ts` | Who is in which session, and the clocks. Nothing on disk: a restart ends every session, said out loud rather than worked around |
| `live/protocol.ts` | Two message kinds, sync and awareness. The server's half of the wire |
| `live/routes.ts` | Four routes and a socket |
| `web/live/provider.ts` | The browser's half of the same wire |
| `web/live/LiveNote.tsx` | The guest's page: the editor and nothing else |
| `web/live/LivePanel.tsx` | The owner's panel, in the commit panel's shape |

**Two clocks, as sharing has two.** `graceUntil` is five minutes and covers the tunnel, the closed
lid and the backgrounded phone: the guests keep editing and the owner slots back in. `keepUntil` is
an hour and covers the owner who is not coming back soon: no new guests, nobody editing, the
document held so they can return and save it. Deleting it when the grace period ran out would throw
away work that was really done, and the memory is a few kilobytes. Then: eight guests, thirty
minutes idle (measured from the last *change*, not the last connection — a room full of moving
carets is an idle room), eight hours for a sitting.

**Every socket is under `/ws`.** A reverse proxy only forwards an upgrade on the paths it was told
about, and the deployment's nginx has one `location /ws` doing that. The session socket lived at
`/live-ws/<id>` for one release: every test passed and every session in production said "connection
lost", because nginx proxied the handshake as an ordinary request. An e2e test now asserts the
invariant rather than the configuration, since there is no nginx in the suite.

**The owner's socket is told apart by a ticket.** A browser cannot put a header on a WebSocket
handshake, so `POST /api/live` hands back a random ticket and the owner's socket carries it in the
query. It grants one thing — to be treated as the owner of a session this account started and can
end — and it dies with the session. A session cookie was the alternative, and the GitHub deployment
does not have one.

## Abuse, which is the whole reason this is a switch

An endpoint that stores arbitrary text is a pastebin; one that accepts anonymous *writes* is worse.
What pays for it: there is no standing writable endpoint at all — a session exists only because a
signed-in owner started it, one at a time per account, and the owner can end it in one press. Guests
are capped, the clocks collect what nobody is using, and the id is six characters from an alphabet
with no `i`, `l`, `o`, `0` or `1`. `INKSTONE_LIVE` is the switch, off by default, and on a GitHub
deployment `GITHUB_OWNER` is required or the server refuses to start: a feature where nobody is
answerable for the socket existing is not one to leave running.

The sign-in screen's promise gained its clause when sharing shipped — *"your notes go from your
browser to GitHub, never through this server — except a note you choose to share."* A live-shared
note goes through this server too, in both directions, for as long as the session lasts. Pressing
the button is choosing that.

## Three things worth keeping written down

**The interface was in the wrong language and the wrong vocabulary.** The first version of the
panel and the guest page invented their own look — Chinese copy in an English interface, a coloured
dot in the panel head, uppercase mini-labels, a bulleted list of terms, a boxed input for the link.
Reported as "UI 风格不对", which it was. They are now the share panel's markup and the shared page's
chrome, class for class: `share.css` and `shared.css` do the work, and `live.css` holds only what
neither of them has — who is here, the name card, and the remote caret.

**A websocket route registered before the plugin is a plain HTTP route.** `app.ts` already says this
at length for `/ws`, and live collaboration earned it again: registered next to the other routes,
the handshake answered 500 because the handler received a `Reply` where it expected a socket. It
belongs in the same `app.after()`.

**Ending a session lost the session.** The editor syncs its text into `content` on a debounce, which
is right — a signal that changed per keystroke would re-render the application per character — but
`stopLive` read `content` and then rebuilt the editor from it. Pressing the button within a second
of typing therefore rebuilt the note *as it stood before anybody joined*, discarding everything the
session had produced. The signature was a test that passed as soon as a wait was added after the
last keystroke, which is a race rather than a missing save. `editor/current.ts` is the fix: the
editor's text, read at the instant it is wanted.

## What is not here

- **No reclaim yet.** A session held after the grace period is kept by the server and `GET
  /api/live/mine` reports it, but the browser does not yet offer to take the result — it reconnects
  into it and the owner saves as usual. The missing piece is the prompt.
- No guest cursor *list* on the guest's side beyond the faces, no chat, no per-guest permissions, no
  session history. A session is a sitting.
