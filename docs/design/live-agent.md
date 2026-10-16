# The agent API

An HTTP API onto a live session, so a program outside this application can read the note and edit
it. **There is no AI in Inkstone.** The agent is whatever the user points at the API — their own
script, a coding agent in a terminal, a cron job — and the only thing this project ships for it
besides the endpoints is a skill file telling it how to behave.

This replaces [the agent](agent.md), which was a local binary, a pairing code, a relay and a side
panel. All of that existed to give the browser a way to *reach* an AI; nothing here needs to reach
anything, so all of it is deleted.

> 我不太喜欢之前那个 agent 模式，我现在的新想法是通过 live 共享界面，AGENT 通过 API 读取/修改 …
> 只需要 API 就够了，这一侧没有任何 AI 成分，然后你提供一个 SKILL，教 agent 怎么在一个 live doc 上编辑。

## Why the session is the right place for it

A live session (`live-share.md`) already has everything an agent needs and nothing it does not: a
document the server holds, a wire that carries changes to everybody, a presence list, and an ending
that writes the note once. An agent joining a session is a collaborator with a name, watched by
somebody who is already there. An agent editing a *file* is a process with write access to a
repository, which is a different product with a different threat model.

The scope is therefore **one note — the session's** — and deliberately not the vault. No listing, no
reading other notes, no search. A session is what the agent can see.

## The hard constraint

**The server cannot read or write the document.** A session's document is a Yjs `XmlFragment`, and
turning it into *this application's* markdown needs a ProseMirror schema and the serialiser the web
layer customises (`writeWhatWasTyped`, `writeTablesAsTyped`, the escapes, emoji, mermaid). So an API
that trades in markdown needs somebody to translate, and there were four candidates:

| | reads | writes | what it costs |
|---|---|---|---|
| A client is the agent's hands | a round trip | ✅ | needs a connected client |
| **A markdown mirror in the CRDT** | **direct, no schema** | ✗ | derived state: one designated writer |
| The schema on the server | ✅ | ✅ | Milkdown in Node, a DOM shim, and **a second markdown dialect** — one that drifts rewrites people's notes on every agent touch |
| The agent speaks Yjs as a peer | ✅ | ✅ | the same cost, moved into the agent; and an LLM cannot curl a CRDT |

**Reads come from the mirror, writes go through a client.** The third option is the only one that
would let an agent edit a note nobody has open, and it is rejected for the dialect risk: this
project has been bitten by exactly that class of bug before — `<br />` written for blank lines, the
escapes, the table spelling — and a serialiser copy in the server would be a second chance at all of
them.

## The surface

Bearer token, **one per session**, shown in the panel for the owner to hand over, dead when the
session ends. The session id alone is not enough: it is a capability to *edit in a browser*, and an
API key is long-lived, scriptable and logged, so it is a separate thing to give away.

```
GET /api/live/:id/text
  200 { note, version, text, editors: [{ name, color }], applying: true }

POST /api/live/:id/edit
  { version?: 41, ops: [ { find, replace } | { insertAfterHeading, text } | { append, text } ] }
  200 { version, text, applied: [{ op: 0, matched: 1 }] }
  409 { error: "the note moved", version, text, hint: "re-read and redo your ops" }
  422 { error: "anchor not found", op: 0, matched: 0, hint: … }
  503 { error: "nobody is applying edits right now", hint: "no connected editor; retry" }
```

**The error bodies are the documentation.** Their reader is a language model, so each one carries
what went wrong, the current text, and what to do next — not a status code for a human to look up.
`version` is a counter the server bumps whenever the mirror changes; sending it makes an edit
conditional, and a conflict answers with the new text so the agent can redo its own work rather
than ask.

## Why anchored ops rather than a new document

The three ops are chosen so that each one is **a local ProseMirror transaction**: `find`/`replace`
touches only the matched range, `insertAfterHeading` inserts after one node, `append` adds at the
end. That matters three times over — the CRDT delta is small, nobody else's cursor moves, and the
change is *one step in the owner's undo history*. An API that took a whole new document would leave
the client no choice but to rebuild the document from markdown: every selection in the room jumps,
and the delta is the whole note.

It is also, not coincidentally, the shape a language model produces well.

**The rules every op obeys**, because each of them is a way an agent gets it wrong:

- **A request is atomic.** Either every op applies or none does, and a refusal names which op
  stopped it. Half an edit is worse than no edit: the agent cannot tell what state it left behind.
- **An anchor must match exactly once.** Zero matches is 422 `anchor not found`; two or more is 422
  `anchor is ambiguous`, with the count — because "the first one" is a guess about somebody else's
  note, and the agent can always send more context instead.
- **`find` is literal text**, not a pattern: a regular expression from a language model is a way to
  match something nobody meant. Matching spans inline marks but never crosses a block boundary.
- **`version` is optional and conditional.** Sent, the edit is refused if the note moved; omitted,
  the edit applies to whatever is there now. The skill tells the agent to send it.
- **`insertAfterHeading` matches the heading's text**, under the same once-only rule, and inserts
  after the heading's own block rather than at the end of its section — an agent that means the end
  of a section can anchor on what is there.

## How a write lands

1. The client keeps a `Y.Text` mirror of the note's markdown, written on every document change. The
   server reads it without a schema, which is what makes `GET /text` instant even when the only
   client is a throttled phone.
2. The agent's ops go into a `Y.Array` inbox.
3. A connected client takes them, translates each into a transaction — markdown in a `replace` is
   parsed with the editor's own parser (`parserCtx`), so what the agent writes is spelled the way
   the editor spells it — and applies them **locally**, then marks them done and refreshes the
   mirror.
4. `POST /edit` answers when they are marked done, or 503 on a timeout.

**The undo trade-off, stated.** Applying the agent's ops locally puts them in the owner's undo
stack, so `Cmd+Z` takes back what the agent did; the cost is that the change is attributed to the
owner rather than to the agent. The alternative — the agent as its own Yjs origin — gets honest
attribution and loses `Cmd+Z` entirely, because `y-prosemirror`'s undo tracks only
`[ySyncPluginKey]` and remote changes never enter the local stack (checked, not assumed). Undo won,
and the visibility it costs is bought back twice: the agent appears in the presence list by name and
colour — the server has the `Awareness`, so it needs no browser to be in the room — and the panel
says what it last changed.

## The skill

A file in the repository written for an agent rather than for a person, teaching the loop (read,
edit, verify), and four things it will otherwise get wrong:

- **somebody else is typing.** Anchors move. Send `version`, expect 409, re-read and redo.
- **do not rewrite the note.** Anchored ops or nothing; a whole-document replacement is refused.
- **nothing is committed until the session ends.** The owner ends it; the agent cannot.
- **the limits**, below, and what each refusal means.

## Limits

One token per session; both endpoints take it. Twenty ops a request, 64 KB of request body, sixty
requests a minute per session, and `POST /edit` waits at most eight seconds for a client to apply
before answering 503. Small on purpose: the caller is a program in a loop, and the person who will
notice it running away is the one whose note is being edited.

## What this cannot do

**No session, no hands.** An agent cannot touch a note nobody has open: the workflow is open the
note, start a session, hand over the link and the token. Making it work unattended means the
schema on the server, which is the row this design rejected.

## Testing

The op-to-transaction translation is unit-tested in the web layer. One e2e drives the API *as the
agent* with Playwright's `request`, against a real session in a real browser: the edit appears in
the owner's editor, the note holds it after the session ends, and each of 409, 422 and 503 says what
it is supposed to say.
