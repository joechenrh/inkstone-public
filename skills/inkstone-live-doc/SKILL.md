---
name: inkstone-live-doc
description: Use when editing a note in an Inkstone live session — reading and changing a markdown document that somebody else has open in their editor, through the session's HTTP API, given a session link and an agent token.
---

# Editing a live Inkstone note

You have a session link — `https://<host>/live/<id>` — and an agent token. The note is **open in
somebody's editor right now** and they are watching: your edits appear on their screen as you make
them, and they can undo them.

Two requests, both with `Authorization: Bearer <token>`.

## The loop

1. **Read.** `GET https://<host>/api/live/<id>/text`
   → `{ note, version, text, editors, applying }`
2. **Decide the smallest edits that do the job.** Not a rewrite — see the rules.
3. **Write.** `POST https://<host>/api/live/<id>/edit`
   → `{ "version": <from step 1>, "ops": [ … ] }`
4. **Read the answer.** `200` carries the new `text` and `version`. Anything else tells you what to
   do next, in words; do the thing it says rather than retrying the same request.

`applying: false` means no browser is connected to apply an edit at this instant — the person's
phone is in their pocket. A read still works; a write will answer `503`.

## The ops

| op | what it does |
|---|---|
| `{"find": "exact text", "replace": "new text"}` | replaces that text where it stands, inline |
| `{"insertAfterHeading": "Next week", "text": "- a new item"}` | parses the markdown and inserts it after that heading's own line |
| `{"append": "## A new section\n\nbody"}` | parses the markdown and puts it at the end of the note |

`find` is **literal text, not a pattern**. It may span bold or italic — what reads as one phrase is
one phrase — but it may not cross a paragraph break or a picture. It must match **exactly once**.

Ops in one request are applied in order, as one change: an anchor an earlier op wrote is a
legitimate anchor for a later one.

## What will go wrong, and what to do

| answer | what it means | what to do |
|---|---|---|
| `409 the note moved` | somebody typed while you were thinking | the body carries the current `text` and `version`: re-read it, redo your ops against it, send again. Never retry the same ops blind |
| `422 anchor not found` | your `find` text is not in the note as written | re-read. Do not guess at punctuation or whitespace |
| `422 anchor is ambiguous` | it matched more than once; `matched` says how many | send more of the surrounding text so it matches once |
| `422 send ops, not a document` | you sent a whole note | there is no endpoint for that. Use anchored ops |
| `503 nobody is applying edits right now` | no browser is connected at this moment | wait a few seconds and retry. The session is still alive |
| `429 too many requests` | sixty a minute per session | wait |
| `401` | wrong credential | the **agent token**, not the session id. Ask whoever sent the link |
| `404 no such session` | the session ended, or the id is wrong | ask for a new link. Nothing you do brings it back |

## Rules

- **Never send the whole document.** There is no endpoint for it. A rewrite would throw away what
  the people in the session are typing while you work.
- **Always send `version`.** Without it your edit applies on top of whatever is there, including
  half of somebody's sentence.
- **Twenty ops a request, 64 KB of body.** Split larger work into batches and re-read between them.
- **You cannot save or commit.** The person hosting the session does that when they end it; until
  then nothing you write is in their git history. Do not ask for it and do not wait for it.
- **You are in the presence list as `agent`.** They can see you are in the room.
- **One note.** A session is a single note. There is no listing, no search, and no other file —
  nothing you can do will reach the rest of their vault.
- **Say what you changed** when you report back. The person watching saw text move; they did not
  necessarily see why.
