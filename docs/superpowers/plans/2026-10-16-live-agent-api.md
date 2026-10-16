# Agent API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An HTTP API onto a live session so a program outside this application can read the open note and edit it, plus a skill file that teaches an agent how to use it — and the deletion of the old agent mode it replaces.

**Architecture:** Reads come from a `Y.Text` mirror of the note's markdown that a connected client keeps up to date, so the server answers them without a ProseMirror schema. Writes go into a `Y.Array` inbox; a connected client translates each op into a *local* ProseMirror transaction (so it lands in the owner's undo stack) and writes a result back, which is what the HTTP request waits for.

**Tech Stack:** Fastify, Yjs (`yjs`, `y-protocols`), Preact + `@preact/signals`, Milkdown/Crepe (`@milkdown/kit`, `@milkdown/plugin-collab`), Vitest, Playwright.

**Spec:** `docs/design/live-agent.md` (and `docs/design/live-share.md`, which this builds on)

## Global Constraints

- **No AI in this application.** No model names, no prompts, no backend seam, no outbound channel. The agent is whoever calls the API.
- **Scope is one note** — the session's. No listing, no reading other notes, no search.
- **The server never parses or serialises the document.** It reads a `Y.Text` and relays opaque updates. A ProseMirror schema or a markdown serialiser appearing in `src/server/` fails this plan.
- **English in every label, message and error.** The interface is English; so are the API's error strings.
- **Error bodies are written for a language model**: each carries what went wrong, the current state, and what to do next (`hint`), never a bare status code.
- **A request is atomic.** Every op applies or none does.
- **An anchor must match exactly once.** Zero → 422 `anchor not found`; two or more → 422 `anchor is ambiguous`, with the count.
- **`find` is literal text**, never a pattern. A match may span inline marks; it may never cross a block boundary.
- Limits, exactly: **20 ops** per request, **64 KB** request body, **60 requests per minute** per session, **8 s** wait for a client before 503.
- Commits: subject says what changed, no version number, and ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Tests are capped: `pnpm vitest run --maxWorkers=2`, and Playwright's config is already `workers: 1`.

---

## File Structure

**Deleted**

| Path | Why |
|---|---|
| `src/agent/` (`main.ts`, `server.ts`, `sessions.ts`, `backend.ts`, `backends/codex-run.ts`) | the local binary |
| `src/web/agent/` (`AgentPanel.tsx`, `api.ts`, `diff.ts`, `agent.css`) | the panel and its pairing client |
| `src/web/state/agent.ts` | the pairing state |
| `tests/agent/agent.test.ts`, `tests/web/agent.test.ts` | their tests |

**Created**

| Path | Responsibility |
|---|---|
| `src/shared/live-ops.ts` | the op types and their validation, used by both ends |
| `src/server/live/mirror.ts` | read the mirror, count versions, park a batch, wait for its result |
| `src/web/live/locate.ts` | find an op's target range in a ProseMirror document (pure; unit-tested) |
| `src/web/live/apply.ts` | turn a located op into a local transaction, write the result back |
| `src/web/live/mirror.ts` | keep the `Y.Text` mirror of the note's markdown |
| `skills/inkstone-live-doc/SKILL.md` | written for an agent, not a person |
| `tests/server/live-mirror.test.ts`, `tests/server/live-agent-routes.test.ts`, `tests/web/live-locate.test.ts`, `tests/e2e/live-agent.spec.ts` | tests |

**Modified**

| Path | Change |
|---|---|
| `src/server/live/routes.ts` | `GET /api/live/:id/text`, `POST /api/live/:id/edit`, the agent token, the rate limit |
| `src/server/live/store.ts` | nothing — the registry stays ignorant of all of this |
| `src/web/editor/CrepeEditor.tsx` | start the mirror and the op consumer when `collab` is set |
| `src/web/live/LivePanel.tsx` | the agent token row |
| `src/web/state/live.ts` | carry `agentToken` |
| `src/web/layout/RightPanel.tsx`, `PhoneSheet.tsx`, `TopBar.tsx`, `state/ui.ts`, `components/SettingsModal.tsx`, `components/icons.tsx` | the old agent mode's holes |
| `vitest.workspace.ts`, `package.json` | drop the `agent` project and its two scripts |
| `docs/design/agent.md`, `docs/design/README.md` | rewritten to say what replaced it |

---

### Task 1: Delete the old agent mode

Nothing in this task is conditional on the rest of the plan: the new API replaces this and the two must not ship side by side. Done first so every later task works in a tree with one AI story in it, not two.

**Files:**
- Delete: `src/agent/`, `src/web/agent/`, `src/web/state/agent.ts`, `tests/agent/agent.test.ts`, `tests/web/agent.test.ts`
- Modify: `src/web/layout/RightPanel.tsx`, `src/web/layout/PhoneSheet.tsx`, `src/web/layout/TopBar.tsx:5,93`, `src/web/state/ui.ts:14,61,73`, `src/web/components/SettingsModal.tsx:13,30-62`, `src/web/components/icons.tsx:93-110`, `vitest.workspace.ts:36-42`, `package.json:9,12`, `docs/design/agent.md`, `docs/design/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `rightTab: Signal<'history'>` is gone — the right panel has one kind of content and no tab strip; `phoneSheet: Signal<'outline' | 'history' | null>`; `togglePhoneSheet(which: 'outline' | 'history')`.

- [ ] **Step 1: Delete the files**

```bash
cd ~/code/inkstone
git rm -r src/agent src/web/agent src/web/state/agent.ts tests/agent tests/web/agent.test.ts
```

- [ ] **Step 2: Take the agent out of the right panel**

`src/web/layout/RightPanel.tsx` keeps one kind of content, so the tab strip goes with the tab: a strip with one tab in it is a label that looks pressable.

```tsx
import { History } from '../history/History.js'
import { rightOpen } from '../state/ui.js'

/**
 * The right panel, which is the file's history and nothing else.
 *
 * It had two tabs and an agent behind the second one. The agent now lives outside this application
 * entirely — see `docs/design/live-agent.md` — and a tab strip with one tab is furniture.
 */
export function RightPanel() {
  if (!rightOpen.value) return null
  return (
    <aside class="ink-right">
      <div class="ink-rightpanel-body"><History /></div>
    </aside>
  )
}
```

Read `src/web/layout/RightPanel.tsx` first and keep whatever it really imports for history — the import above is the shape, not a guess to paste over a different name.

- [ ] **Step 3: Take it out of the phone sheet, the menu and the ui state**

In `src/web/layout/PhoneSheet.tsx`: drop the `AgentPanel` import, the `'agent'` title branch and the `which === 'agent'` body branch.

In `src/web/layout/TopBar.tsx`: drop `IconAgent` from the import list at line 5 and the whole `{ label: 'Agent', … }` menu item at line 93.

In `src/web/state/ui.ts`:

```ts
export const rightTab = signal<'history'>('history')
export const phoneSheet = signal<'outline' | 'history' | null>(null)

export function togglePhoneSheet(which: 'outline' | 'history'): void {
```

Keep `rightTab` exported only if something still reads it; if nothing does, delete it and fix the callers the compiler names.

- [ ] **Step 4: Take the pairing row out of Settings**

In `src/web/components/SettingsModal.tsx`: drop the `../state/agent.js` import (line 13), the `agentState()` and `agentHint()` helpers (lines 30-62) and the Agent row in the body. Settings loses one of its five sections if that section held nothing else — check before deleting the heading.

- [ ] **Step 5: Drop the icon, the test project and the scripts**

`src/web/components/icons.tsx`: delete `IconAgent` and its comment block (lines 93-110).

`vitest.workspace.ts`: delete the whole `{ test: { name: 'agent', … } }` project.

`package.json`: delete the `"dev:agent"` and `"agent"` scripts.

- [ ] **Step 6: Rewrite the design record**

Replace `docs/design/agent.md` with a short record that keeps the history and points at what replaced it:

```markdown
# The agent — replaced

This described an agent that ran as a binary on the user's own machine, paired to the browser with a
code, reached through a relay on this server, and shown in a side panel. It is gone.

Everything in it existed to give the browser a way to *reach* an AI: the pairing, the relay, the
backend seam, the NDJSON event stream. What replaced it needs none of that, because the AI is not
in this application at all — it is whatever the user points at an HTTP API onto a live session. See
[live-agent.md](live-agent.md), and [live-share.md](live-share.md) for the sessions it works on.

What the measurements in the old record established is still true and is why the relay existed:
a page on `https://` cannot reach `http://127.0.0.1` in WebKit, and a phone can never reach another
machine's loopback. Nothing in the new design needs either.
```

Update the line for it in `docs/design/README.md` to say so.

- [ ] **Step 7: Run everything**

```bash
pnpm typecheck && pnpm vitest run --maxWorkers=2 && pnpm build && pnpm exec playwright test --reporter=line
```

Expected: typecheck clean, the unit count down by the two deleted files' tests, e2e unchanged and green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -F - <<'MSG'
Delete the agent mode the API replaces

A binary on the user's machine, a pairing code, a relay through this server and a side panel — all
of it there to give the browser a way to reach an AI. The replacement needs none of it: there is no
AI in this application any more, only an HTTP API onto a live session that somebody else's program
calls. The old record is kept as a pointer, including the measurements that made the relay the right
shape at the time.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 2: The op types, shared by both ends

**Files:**
- Create: `src/shared/live-ops.ts`
- Test: `tests/server/live-ops.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type LiveOp =
    | { find: string; replace: string }
    | { insertAfterHeading: string; text: string }
    | { append: string }
  export interface LiveBatch { id: string; ops: LiveOp[] }
  export type LiveFailure =
    | { kind: 'missing'; op: number; needle: string }
    | { kind: 'ambiguous'; op: number; needle: string; matched: number }
  export interface LiveResult { id: string; failure?: LiveFailure }
  export const MAX_OPS = 20
  export function parseOps(value: unknown): { ops: LiveOp[] } | { error: string }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { MAX_OPS, parseOps } from '../../src/shared/live-ops.js'

describe('what an agent is allowed to send', () => {
  it('takes the three ops', () => {
    expect(parseOps([{ find: 'a', replace: 'b' }])).toEqual({ ops: [{ find: 'a', replace: 'b' }] })
    expect(parseOps([{ insertAfterHeading: 'Next week', text: '- x' }]))
      .toEqual({ ops: [{ insertAfterHeading: 'Next week', text: '- x' }] })
    expect(parseOps([{ append: 'tail' }])).toEqual({ ops: [{ append: 'tail' }] })
  })

  it('refuses an empty anchor, because everything matches it', () => {
    expect(parseOps([{ find: '', replace: 'b' }])).toEqual({ error: 'op 0: find cannot be empty' })
  })

  it('refuses a whole-document replacement however it is spelled', () => {
    expect(parseOps({ text: 'the whole note' })).toEqual({
      error: 'send ops, not a document: [{"find":…,"replace":…}]',
    })
  })

  it('names the op that is wrong, so an agent can fix that one', () => {
    expect(parseOps([{ append: 'ok' }, { nonsense: 1 }])).toEqual({
      error: 'op 1: expected find/replace, insertAfterHeading/text, or append',
    })
  })

  it('caps the batch', () => {
    const many = Array.from({ length: MAX_OPS + 1 }, () => ({ append: 'x' }))
    expect(parseOps(many)).toEqual({ error: `too many ops: ${MAX_OPS} at a time` })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/server/live-ops.test.ts --maxWorkers=2`
Expected: FAIL — `src/shared/live-ops.ts` does not exist.

- [ ] **Step 3: Write it**

```ts
/**
 * What an agent may ask for, and the refusals that teach it to ask better.
 *
 * Shared by the server, which validates, and the browser, which applies — one definition, because
 * two would drift and the drift would be silent. Every message here is read by a language model:
 * it names the op that is wrong and says what was expected, so the next attempt can be right.
 */

export type LiveOp =
  | { find: string; replace: string }
  | { insertAfterHeading: string; text: string }
  | { append: string }

/** One request's worth, with an id the result is matched to. */
export interface LiveBatch {
  id: string
  ops: LiveOp[]
}

export type LiveFailure =
  | { kind: 'missing'; op: number; needle: string }
  | { kind: 'ambiguous'; op: number; needle: string; matched: number }

/**
 * What the browser writes back: the batch it finished, and why it finished nothing if it did.
 *
 * No version in it. The browser does not know the server's counter — the server reads the mirror
 * itself once the batch has landed — and a field each end guesses at is a field that disagrees.
 */
export interface LiveResult {
  id: string
  failure?: LiveFailure
}

/** Twenty is more than a person would ask for in one breath and fewer than a loop produces. */
export const MAX_OPS = 20

const SHAPE = 'expected find/replace, insertAfterHeading/text, or append'

export function parseOps(value: unknown): { ops: LiveOp[] } | { error: string } {
  if (!Array.isArray(value)) {
    return { error: 'send ops, not a document: [{"find":…,"replace":…}]' }
  }
  if (value.length === 0) return { error: 'no ops' }
  if (value.length > MAX_OPS) return { error: `too many ops: ${MAX_OPS} at a time` }

  const ops: LiveOp[] = []
  for (const [at, raw] of value.entries()) {
    const one = raw as Record<string, unknown>
    if (typeof one?.find === 'string' && typeof one.replace === 'string') {
      // An empty anchor matches everywhere, which is the same as matching nothing anybody meant.
      if (one.find === '') return { error: `op ${at}: find cannot be empty` }
      ops.push({ find: one.find, replace: one.replace })
      continue
    }
    if (typeof one?.insertAfterHeading === 'string' && typeof one.text === 'string') {
      if (one.insertAfterHeading === '') return { error: `op ${at}: insertAfterHeading cannot be empty` }
      ops.push({ insertAfterHeading: one.insertAfterHeading, text: one.text })
      continue
    }
    if (typeof one?.append === 'string') {
      ops.push({ append: one.append })
      continue
    }
    return { error: `op ${at}: ${SHAPE}` }
  }
  return { ops }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/server/live-ops.test.ts --maxWorkers=2`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/live-ops.ts tests/server/live-ops.test.ts
git commit -F - <<'MSG'
The three ops an agent may send, and the refusals that teach it

One definition for both ends, because two would drift silently. Every refusal names the op that is
wrong and says what was expected: the reader is a language model, and "400 Bad Request" tells it
nothing it can act on.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 3: Reading a session — the mirror and `GET /api/live/:id/text`

**Files:**
- Create: `src/server/live/mirror.ts`, `tests/server/live-mirror.test.ts`
- Modify: `src/server/live/routes.ts`
- Test: `tests/server/live-agent-routes.test.ts`

**Interfaces:**
- Consumes: `LiveBatch`, `LiveResult` from `src/shared/live-ops.js`; `LiveStore`, `LiveSession` from `./store.js`.
- Produces:
  ```ts
  export const MIRROR = 'markdown'
  export const INBOX = 'agentInbox'
  export const RESULTS = 'agentResults'
  export interface Mirror {
    text: () => string
    version: () => number
    /** Park a batch for a client to apply, and wait for its result. */
    submit: (batch: LiveBatch, waitMs: number) => Promise<LiveResult | 'timeout'>
    stop: () => void
  }
  export function watchMirror(doc: Y.Doc): Mirror
  ```
  and on the session's `Live` record in `routes.ts`: `agentToken: string`, `mirror: Mirror`.

- [ ] **Step 1: Write the failing test for the mirror**

```ts
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { INBOX, MIRROR, RESULTS, watchMirror } from '../../src/server/live/mirror.js'
import type { LiveResult } from '../../src/shared/live-ops.js'

/**
 * The server's whole view of a session's text.
 *
 * It reads a `Y.Text` and counts its changes; it never parses the document. These tests are a bare
 * `Y.Doc` standing in for a browser, which is exactly what the server cannot tell apart.
 */
describe('the mirror', () => {
  it('is empty and version zero before a client has written one', () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)
    expect(mirror.text()).toBe('')
    expect(mirror.version()).toBe(0)
    mirror.stop()
  })

  it('reads what a client wrote, with no schema anywhere', () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)
    doc.getText(MIRROR).insert(0, '# Weekly\n\n- one\n')
    expect(mirror.text()).toBe('# Weekly\n\n- one\n')
    mirror.stop()
  })

  it('counts a version per change, so an edit can be made conditional', () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)
    doc.getText(MIRROR).insert(0, 'a')
    doc.getText(MIRROR).insert(1, 'b')
    expect(mirror.version()).toBe(2)
    mirror.stop()
  })

  it('parks a batch where a client will see it, and answers with the result', async () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)

    // A client: sees the inbox, does the work, writes a result under the batch id.
    doc.getArray(INBOX).observe(() => {
      const batch = doc.getArray(INBOX).get(0) as { id: string }
      doc.getText(MIRROR).insert(0, 'done')
      doc.getMap(RESULTS).set(batch.id, { id: batch.id } satisfies LiveResult)
    })

    const answer = await mirror.submit({ id: 'b1', ops: [{ append: 'x' }] }, 1000)
    expect(answer).toEqual({ id: 'b1' })
    // The version is the server's own count of the mirror, not something the browser reported.
    expect(mirror.version()).toBe(1)
    // And the inbox is left clean: a batch nobody removed would be applied twice on reconnect.
    expect(doc.getArray(INBOX).length).toBe(0)
    mirror.stop()
  })

  it('says timeout when nothing is applying, rather than hanging', async () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)
    expect(await mirror.submit({ id: 'b2', ops: [{ append: 'x' }] }, 30)).toBe('timeout')
    // And takes its batch back, so a client arriving later does not apply a request nobody awaits.
    expect(doc.getArray(INBOX).length).toBe(0)
    mirror.stop()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/server/live-mirror.test.ts --maxWorkers=2`
Expected: FAIL — no `src/server/live/mirror.ts`.

- [ ] **Step 3: Write the mirror**

```ts
import * as Y from 'yjs'
import type { LiveBatch, LiveResult } from '../../shared/live-ops.js'

/**
 * The server's whole view of a session's text, and the only way it reaches one.
 *
 * A session's document is a Yjs `XmlFragment` that needs a ProseMirror schema to read, and putting
 * that schema here would mean Milkdown in Node and a second markdown dialect — see
 * `docs/design/live-agent.md`. So a client keeps a plain `Y.Text` of the note's markdown beside the
 * document, and this reads *that*: no schema, no parser, no serialiser. The cost is that writing
 * needs a client, which is what `submit` is.
 */

/** The `Y.Text` a client keeps in step with the document. */
export const MIRROR = 'markdown'
/** Batches waiting for a client. */
export const INBOX = 'agentInbox'
/** Results, keyed by batch id. */
export const RESULTS = 'agentResults'

export interface Mirror {
  text: () => string
  version: () => number
  submit: (batch: LiveBatch, waitMs: number) => Promise<LiveResult | 'timeout'>
  stop: () => void
}

export function watchMirror(doc: Y.Doc): Mirror {
  const text = doc.getText(MIRROR)
  const results = doc.getMap<LiveResult>(RESULTS)
  const inbox = doc.getArray<LiveBatch>(INBOX)
  /*
   * Counted rather than derived from the text.
   *
   * A hash of the markdown would be stable across a change that undid itself, and an agent holding
   * a stale version would be told its edit was safe. A counter only ever moves forward.
   */
  let version = 0
  const onText = () => { version += 1 }
  text.observe(onText)

  return {
    text: () => text.toString(),
    version: () => version,

    submit: async (batch, waitMs) => await new Promise<LiveResult | 'timeout'>((resolve) => {
      let settled = false
      const finish = (answer: LiveResult | 'timeout') => {
        if (settled) return
        settled = true
        results.unobserve(onResult)
        clearTimeout(timer)
        results.delete(batch.id)
        // The batch goes either way: one nobody removed is applied twice the next time a client
        // syncs, and an agent that timed out is not waiting for it any more.
        const at = inbox.toArray().findIndex((one) => one.id === batch.id)
        if (at >= 0) inbox.delete(at, 1)
        resolve(answer)
      }
      function onResult(): void {
        const found = results.get(batch.id)
        if (found !== undefined) finish(found)
      }
      results.observe(onResult)
      const timer = setTimeout(() => { finish('timeout') }, waitMs)
      inbox.push([batch])
    }),

    stop: () => { text.unobserve(onText) },
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/server/live-mirror.test.ts --maxWorkers=2`
Expected: PASS (5 tests)

- [ ] **Step 5: Write the failing test for the route**

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerLiveRoutes } from '../../src/server/live/routes.js'

/** An owner starts a session; an agent reads it with the token the owner was given. */
async function sessionWith(): Promise<{ app: FastifyInstance; id: string; token: string }> {
  const app = Fastify()
  app.decorate('isAuthenticated', () => true)
  registerLiveRoutes(app, { config: { owner: null } })
  const started = (await app.inject({
    method: 'POST',
    url: '/api/live',
    payload: { path: 'notes/weekly.md', title: 'weekly.md' },
  })).json() as { id: string; agentToken: string }
  return { app, id: started.id, token: started.agentToken }
}

describe('reading a session as an agent', () => {
  it('needs the agent token, and the session id is not it', async () => {
    const { app, id } = await sessionWith()
    expect((await app.inject({ method: 'GET', url: `/api/live/${id}/text` })).statusCode).toBe(401)
    expect((await app.inject({
      method: 'GET',
      url: `/api/live/${id}/text`,
      headers: { authorization: `Bearer ${id}` },
    })).statusCode).toBe(401)
    await app.close()
  })

  it('answers the note, the version and who is editing', async () => {
    const { app, id, token } = await sessionWith()
    const res = await app.inject({
      method: 'GET',
      url: `/api/live/${id}/text`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      note: 'notes/weekly.md',
      version: 0,
      text: '',
      editors: [],
      applying: false,
    })
    await app.close()
  })

  it('says one sentence for a session that is not running', async () => {
    const { app, token } = await sessionWith()
    const res = await app.inject({
      method: 'GET',
      url: '/api/live/zzzzzz/text',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ hint: expect.stringContaining('session') })
    await app.close()
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm vitest run tests/server/live-agent-routes.test.ts --maxWorkers=2`
Expected: FAIL — no `agentToken` in the start response, 404 on the text route.

- [ ] **Step 7: Add the token and the route**

In `src/server/live/routes.ts`, inside the `Live` record and `live()`:

```ts
interface Live {
  room: Room
  ticket: string
  /** The agent's own credential: the id is a capability to edit in a browser, which is not this. */
  agentToken: string
  mirror: Mirror
  stopRelay: () => void
  seats: Map<Wire, Seat>
}
```

```ts
    const made: Live = {
      room,
      ticket: randomBytes(24).toString('base64url'),
      agentToken: randomBytes(24).toString('base64url'),
      mirror: watchMirror(session.doc),
      stopRelay: relay(room),
      seats: new Map(),
    }
```

`shut()` gains `found.mirror.stop()` beside `found.stopRelay()`.

`POST /api/live` and `GET /api/live/mine` gain `agentToken: live(session).agentToken` in their replies.

Then the route itself:

```ts
  /**
   * Whose session this is, for an agent.
   *
   * A separate credential from the owner's, and from the id: the id is a capability to edit in a
   * browser and gets pasted into chat windows; this is scriptable and logged. One per session, dead
   * when the session is.
   */
  function agentOf(req: FastifyRequest, id: string): Live | null {
    const found = rooms.get(id)
    if (found === undefined) return null
    const given = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    if (given === undefined || given !== found.agentToken) return null
    return found
  }

  const NO_SESSION = {
    error: 'no such session',
    hint: 'the session ended, or the id is wrong: ask whoever gave you the link for a new one',
  }

  app.get('/api/live/:id/text', async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = store.get(id)
    const here = agentOf(req, id)
    if (session === null || here === null) {
      // The same answer for "not a session" and "not your token": which one it was is a fact about
      // somebody else's notes.
      return await reply.code(session === null ? 404 : 401).send(
        session === null ? NO_SESSION : { error: 'not this session\'s token', hint: 'ask the owner for the agent token shown in their Live share panel' },
      )
    }
    return await reply.send({
      note: session.path,
      version: here.mirror.version(),
      text: here.mirror.text(),
      editors: [...here.room.awareness.getStates().values()]
        .map((state) => (state as { user?: { name?: string; color?: string } }).user)
        .filter((user): user is { name: string; color: string } =>
          typeof user?.name === 'string' && typeof user.color === 'string'),
      // Whether anybody is in a position to apply an edit, which is the one thing an agent cannot
      // find out for itself and the difference between "retry" and "give up".
      applying: [...here.seats.values()].length > 0,
    })
  })
```

Add `import { watchMirror, type Mirror } from './mirror.js'` at the top.

- [ ] **Step 8: Run both suites**

Run: `pnpm vitest run tests/server --maxWorkers=2`
Expected: PASS, including the existing `live-routes.test.ts` — the start response gained a field, so if that file asserts an exact object it needs `agentToken: expect.any(String)`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -F - <<'MSG'
An agent can read the session's note

The server's whole view of a session's text is a Y.Text a client keeps beside the document: reading
it needs no ProseMirror schema, which is what keeps Milkdown and a second markdown dialect out of
this process. The version is counted rather than hashed — a hash would be stable across a change
that undid itself, and an agent holding a stale version would be told its edit was safe.

The credential is its own: the session id is a capability to edit in a browser and gets pasted into
chat windows, and an API token is scriptable and logged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 4: Finding an op's target in the document

Pure, and the only part of applying an op that can be tested without an editor. `prosemirror-model` runs in Node with no DOM, so the test builds a tiny schema of its own.

**Files:**
- Create: `src/web/live/locate.ts`
- Test: `tests/web/live-locate.test.ts`

**Interfaces:**
- Consumes: `LiveOp` from `src/shared/live-ops.js`.
- Produces:
  ```ts
  export interface Hit { from: number; to: number }
  export type Located = { hits: Hit[] } | { blockEnd: number } | { docEnd: number }
  export function findText(doc: ProseNode, needle: string): Hit[]
  export function findHeading(doc: ProseNode, text: string): Hit[]
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { findHeading, findText } from '../../src/web/live/locate.js'

/**
 * Where an op lands, and the two ways it refuses.
 *
 * `prosemirror-model` is pure JavaScript, so this needs no editor and no DOM — a schema of four
 * nodes and one mark is enough to prove the rules the API promises: a match spans inline marks, it
 * never crosses a block, and anything other than exactly one hit is the caller's problem.
 */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
    text: { group: 'inline' },
  },
  marks: { strong: {} },
})

const doc = (...blocks: unknown[]) => schema.node('doc', null, blocks as never)
const p = (...inline: unknown[]) => schema.node('paragraph', null, inline as never)
const h = (level: number, text: string) => schema.node('heading', { level }, [schema.text(text)])
const t = (text: string) => schema.text(text)
const b = (text: string) => schema.text(text, [schema.mark('strong')])

describe('finding text to replace', () => {
  it('finds it once, in document positions', () => {
    const found = findText(doc(p(t('before and after'))), 'and')
    expect(found).toHaveLength(1)
    expect(found[0]).toEqual({ from: 8, to: 11 })
  })

  it('reports every hit, because two is ambiguous and the caller must know', () => {
    expect(findText(doc(p(t('a a a'))), 'a')).toHaveLength(3)
  })

  it('reports none rather than guessing', () => {
    expect(findText(doc(p(t('nothing here'))), 'absent')).toEqual([])
  })

  it('spans inline marks: what a reader sees as one phrase is one phrase', () => {
    // "very bold text", where "bold" is strong.
    const found = findText(doc(p(t('very '), b('bold'), t(' text'))), 'very bold text')
    expect(found).toHaveLength(1)
  })

  it('never crosses a block: two paragraphs are not one sentence', () => {
    expect(findText(doc(p(t('end of one')), p(t('start of two'))), 'one start')).toEqual([])
  })
})

describe('finding a heading', () => {
  it('matches its text, at any level', () => {
    const found = findHeading(doc(h(1, 'Weekly'), p(t('x')), h(2, 'Next week')), 'Next week')
    expect(found).toHaveLength(1)
  })

  it('reports every heading with that text', () => {
    expect(findHeading(doc(h(2, 'Notes'), p(t('x')), h(3, 'Notes')), 'Notes')).toHaveLength(2)
  })

  it('ignores a paragraph that happens to say the same thing', () => {
    expect(findHeading(doc(p(t('Next week'))), 'Next week')).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/web/live-locate.test.ts --maxWorkers=2`
Expected: FAIL — no `src/web/live/locate.ts`.

- [ ] **Step 3: Write it**

```ts
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

/**
 * Where an op lands.
 *
 * Separated from applying it because this half is the half with rules in it, and the rules are
 * promises the API makes: a match spans inline marks, it never crosses a block boundary, and
 * anything other than exactly one hit is reported rather than guessed at. All three are testable
 * without an editor, and none of them is obvious enough to leave to an e2e.
 */

export interface Hit {
  from: number
  to: number
}

/**
 * Every place `needle` appears, in document positions.
 *
 * Block by block, which is what keeps a match from crossing one: the text of a block is its inline
 * content with the marks ignored, so `**bold**` inside a sentence does not break a phrase in two —
 * what a reader sees as one phrase is one phrase. Two blocks are never joined, so a needle with a
 * paragraph break in it matches nothing, which is the honest answer.
 */
export function findText(doc: ProseNode, needle: string): Hit[] {
  const hits: Hit[] = []
  if (needle === '') return hits
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const text = node.textBetween(0, node.content.size, undefined, '￼')
    let at = text.indexOf(needle)
    while (at >= 0) {
      // +1 for the block's own opening token: inline position 0 is one past the node's position.
      hits.push({ from: pos + 1 + at, to: pos + 1 + at + needle.length })
      at = text.indexOf(needle, at + 1)
    }
    return false
  })
  return hits
}

/** Every heading whose text is exactly `text`, at any level. A paragraph is not a heading. */
export function findHeading(doc: ProseNode, text: string): Hit[] {
  const hits: Hit[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true
    if (node.textContent === text) hits.push({ from: pos, to: pos + node.nodeSize })
    return false
  })
  return hits
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/web/live-locate.test.ts --maxWorkers=2`
Expected: PASS (8 tests). If the first test's positions disagree, trust the test's arithmetic over the implementation's: `from` is `pos + 1 + offset`, and a `doc` whose first child is a paragraph puts that paragraph at position 0.

- [ ] **Step 5: Commit**

```bash
git add src/web/live/locate.ts tests/web/live-locate.test.ts
git commit -F - <<'MSG'
Where an agent's op lands in the document

The half of applying an op that has rules in it, and the rules are promises the API makes: a match
spans inline marks so what reads as one phrase is one phrase, it never crosses a block so a needle
with a paragraph break in it matches nothing, and anything other than exactly one hit is reported
rather than guessed at. prosemirror-model is pure JavaScript, so all of it is tested against a
four-node schema with no editor and no DOM.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 5: Applying an op, in the browser

**Files:**
- Create: `src/web/live/apply.ts`, `src/web/live/mirror.ts`
- Modify: `src/web/editor/CrepeEditor.tsx`

**Interfaces:**
- Consumes: `findText`, `findHeading`, `Hit` from `./locate.js`; `LiveBatch`, `LiveResult`, `LiveFailure`, `LiveOp` from `../../shared/live-ops.js`; `MIRROR`, `INBOX`, `RESULTS` — re-exported from `./wire-names.js` so the browser does not import from `src/server/`.
- Produces:
  ```ts
  // src/web/live/mirror.ts
  export function keepMirror(wire: LiveWire, read: () => string): () => void
  // src/web/live/apply.ts
  export function serveAgent(wire: LiveWire, ctx: Ctx, view: EditorView): () => void
  ```

- [ ] **Step 1: Move the three names somewhere both ends may import**

Create `src/shared/live-wire.ts`:

```ts
/**
 * The three fields a session's document carries besides the document.
 *
 * In `src/shared` because both ends need the same strings and neither may import the other's tree:
 * the browser importing from `src/server/` would pull the server's dependencies into the bundle.
 */
export const MIRROR = 'markdown'
export const INBOX = 'agentInbox'
export const RESULTS = 'agentResults'
```

Then `src/server/live/mirror.ts` re-exports them instead of declaring them:

```ts
export { INBOX, MIRROR, RESULTS } from '../../shared/live-wire.js'
import { INBOX, MIRROR, RESULTS } from '../../shared/live-wire.js'
```

Run `pnpm vitest run tests/server/live-mirror.test.ts --maxWorkers=2`: still PASS.

- [ ] **Step 2: Write the mirror writer**

```ts
import { MIRROR } from '../../shared/live-wire.js'
import type { LiveWire } from './provider.js'

/** How long after the last keystroke the mirror catches up. The editor's own debounce, doubled. */
const SETTLE_MS = 400

/**
 * Keep the shared `Y.Text` in step with the note's markdown.
 *
 * This is what lets the server answer an agent's read without a schema — see
 * `server/live/mirror.ts`. Written by whoever is connected, which is a race nobody loses: the text
 * is replaced wholesale with what the document says, and every client's document is the same
 * document. Debounced, because a keystroke is not worth a CRDT update of the whole note.
 */
export function keepMirror(wire: LiveWire, read: () => string): () => void {
  const text = wire.doc.getText(MIRROR)
  let timer = 0

  const write = () => {
    const next = read()
    if (next === text.toString()) return
    // One transaction, so a reader never sees the note half-replaced.
    wire.doc.transact(() => {
      text.delete(0, text.length)
      text.insert(0, next)
    })
  }

  const schedule = () => {
    clearTimeout(timer)
    timer = window.setTimeout(write, SETTLE_MS)
  }

  wire.doc.on('update', schedule)
  // And once immediately: a session that nobody types in should still be readable.
  write()
  return () => {
    clearTimeout(timer)
    wire.doc.off('update', schedule)
  }
}
```

- [ ] **Step 3: Write the op server**

```ts
import { parserCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Slice } from '@milkdown/kit/prose/model'
import { INBOX, RESULTS } from '../../shared/live-wire.js'
import type { LiveBatch, LiveFailure, LiveOp, LiveResult } from '../../shared/live-ops.js'
import { findHeading, findText } from './locate.js'
import type { LiveWire } from './provider.js'

/**
 * The agent's hands.
 *
 * The server cannot turn markdown into this document — see `docs/design/live-agent.md` — so a
 * connected browser does it, and this is that browser. Ops arrive in a `Y.Array`, are applied as
 * **one local transaction**, and the result goes back in a `Y.Map` for the waiting request.
 *
 * Local, deliberately: a local transaction enters this client's undo history, so `Cmd+Z` takes back
 * what the agent did. The cost is that the change is attributed to whoever is hosting rather than to
 * the agent, and the presence list is where the agent is visible instead.
 *
 * One transaction for the batch, so a failure leaves nothing behind: an agent that cannot tell
 * whether half its edit landed has to re-read to find out, and may undo somebody else's work doing
 * it.
 */
export function serveAgent(wire: LiveWire, ctx: Ctx, view: EditorView): () => void {
  const inbox = wire.doc.getArray<LiveBatch>(INBOX)
  const results = wire.doc.getMap<LiveResult>(RESULTS)

  const run = () => {
    const batch = inbox.get(0)
    if (batch === undefined) return

    let tr = view.state.tr
    let failure: LiveFailure | undefined

    for (const [at, op] of batch.ops.entries()) {
      // Each op is located in the document *as the previous ops left it*: a batch is a sequence,
      // and an anchor the previous op wrote is a legitimate anchor for the next.
      const located = locate(tr.doc, op, at)
      if ('failure' in located) { failure = located.failure; break }
      tr = write(tr, ctx, op, located.at)
    }

    if (failure === undefined) view.dispatch(tr)
    results.set(batch.id, { id: batch.id, ...(failure === undefined ? {} : { failure }) })
    const stillThere = inbox.toArray().findIndex((one) => one.id === batch.id)
    if (stillThere >= 0) inbox.delete(stillThere, 1)
  }

  inbox.observe(run)
  // And once on attach: a batch may have been parked while this client was connecting.
  run()
  return () => { inbox.unobserve(run) }
}

type Located = { at: { from: number; to: number } } | { failure: LiveFailure }

function locate(doc: EditorView['state']['doc'], op: LiveOp, at: number): Located {
  if ('find' in op) return once(findText(doc, op.find), op.find, at)
  if ('insertAfterHeading' in op) return once(findHeading(doc, op.insertAfterHeading), op.insertAfterHeading, at)
  const end = doc.content.size
  return { at: { from: end, to: end } }
}

function once(hits: { from: number; to: number }[], needle: string, op: number): Located {
  if (hits.length === 0) return { failure: { kind: 'missing', op, needle } }
  if (hits.length > 1) return { failure: { kind: 'ambiguous', op, needle, matched: hits.length } }
  return { at: hits[0]! }
}

/** The replacement, parsed with the editor's own parser so it is spelled the editor's way. */
function write(
  tr: EditorView['state']['tr'],
  ctx: Ctx,
  op: LiveOp,
  at: { from: number; to: number },
): EditorView['state']['tr'] {
  if ('find' in op) {
    // Inline text, inline replacement: parsing `replace` as a document would wrap a phrase in a
    // paragraph and split the sentence it was part of.
    return tr.insertText(op.replace, at.from, at.to)
  }
  const markdown = 'insertAfterHeading' in op ? op.text : op.append
  const parsed = ctx.get(parserCtx)(markdown)
  if (parsed === null) return tr
  const where = 'insertAfterHeading' in op ? at.to : at.from
  return tr.replace(where, where, new Slice(parsed.content, 0, 0))
}
```

- [ ] **Step 4: Start both from the editor**

In `src/web/editor/CrepeEditor.tsx`, inside the `if (wire !== null)` block that binds the collab service, after `service.connect()`:

```ts
          const view = c.get(editorViewCtx)
          // The agent's two halves: the mirror the server reads, and the hands that apply what it
          // sends. Both belong to the editor's lifetime — see `docs/design/live-agent.md`.
          stopMirror = keepMirror(wire, () => closedMarkdown(c, crepe.getMarkdown()))
          stopAgent = serveAgent(wire, c, view)
```

Declare `let stopMirror = () => {}` and `let stopAgent = () => {}` beside `let disposed = false`, and call both in the effect's teardown next to `provideEditorText(null)`.

- [ ] **Step 5: Typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: both clean. There is no unit test for this step — the e2e in Task 8 is its test, because an op applied to a real document needs a real editor.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -F - <<'MSG'
The browser is the agent's hands

The server cannot turn markdown into this document, so a connected browser does it: ops arrive in a
Y.Array, are applied as one local transaction, and the result goes back in a Y.Map for the waiting
request. Local on purpose — a local transaction enters this client's undo history, so Cmd+Z takes
back what the agent did.

One transaction for the whole batch, so a failure leaves nothing behind. An agent that cannot tell
whether half its edit landed has to re-read to find out, and may undo somebody else's work doing it.

Beside it, the mirror: the note's markdown kept in a Y.Text so the server can answer a read without
a ProseMirror schema.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 6: `POST /api/live/:id/edit`

**Files:**
- Modify: `src/server/live/routes.ts`
- Test: `tests/server/live-agent-routes.test.ts`

**Interfaces:**
- Consumes: `parseOps`, `MAX_OPS` from `src/shared/live-ops.js`; `Mirror.submit` from Task 3.
- Produces: the endpoint. No new exports.

- [ ] **Step 1: Write the failing tests**

Append to `tests/server/live-agent-routes.test.ts`:

```ts
describe('editing a session as an agent', () => {
  const edit = (app: FastifyInstance, id: string, token: string, body: unknown) => app.inject({
    method: 'POST',
    url: `/api/live/${id}/edit`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body as never,
  })

  it('refuses a whole document, and says what to send instead', async () => {
    const { app, id, token } = await sessionWith()
    const res = await edit(app, id, token, { text: 'the whole note' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: expect.stringContaining('send ops') })
    await app.close()
  })

  it('refuses more than twenty ops', async () => {
    const { app, id, token } = await sessionWith()
    const res = await edit(app, id, token, { ops: Array.from({ length: 21 }, () => ({ append: 'x' })) })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: 'too many ops: 20 at a time' })
    await app.close()
  })

  it('says nobody is applying when no browser is connected, rather than hanging', async () => {
    const { app, id, token } = await sessionWith()
    const res = await edit(app, id, token, { ops: [{ append: 'x' }], waitMs: 40 })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      error: 'nobody is applying edits right now',
      hint: expect.stringContaining('retry'),
    })
    await app.close()
  })

  it('refuses a stale version with the current text, so the agent can redo its own work', async () => {
    const { app, id, token } = await sessionWith()
    // A client wrote the mirror once, so the version is 1 and the agent's 0 is stale.
    const res = await edit(app, id, token, { version: 0, ops: [{ append: 'x' }] })
    // With no mirror written yet the version is 0 and this is *not* stale: assert the shape of the
    // refusal with a version that cannot be current.
    expect(res.statusCode).not.toBe(409)
    const stale = await edit(app, id, token, { version: 99, ops: [{ append: 'x' }] })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({
      error: 'the note moved',
      version: 0,
      text: '',
      hint: expect.stringContaining('re-read'),
    })
    await app.close()
  })

  it('needs the agent token like the read does', async () => {
    const { app, id } = await sessionWith()
    expect((await app.inject({
      method: 'POST',
      url: `/api/live/${id}/edit`,
      headers: { 'content-type': 'application/json' },
      payload: { ops: [{ append: 'x' }] },
    })).statusCode).toBe(401)
    await app.close()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/server/live-agent-routes.test.ts --maxWorkers=2`
Expected: FAIL — the route does not exist (404s).

- [ ] **Step 3: Write the route**

```ts
  /** Eight seconds: long enough for a browser that is awake, short enough to be an answer. */
  const APPLY_MS = 8 * 1000

  app.post('/api/live/:id/edit', async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = store.get(id)
    const here = agentOf(req, id)
    if (session === null || here === null) {
      return await reply.code(session === null ? 404 : 401).send(
        session === null ? NO_SESSION : { error: 'not this session\'s token', hint: 'ask the owner for the agent token shown in their Live share panel' },
      )
    }

    const body = (req.body ?? {}) as { ops?: unknown; version?: unknown; waitMs?: unknown }
    const parsed = parseOps(body.ops ?? body)
    if ('error' in parsed) {
      return await reply.code(422).send({
        error: parsed.error,
        version: here.mirror.version(),
        hint: 'anchor on text that is in the note: {"find": "<exact text>", "replace": "<new text>"}',
      })
    }

    if (typeof body.version === 'number' && body.version !== here.mirror.version()) {
      return await reply.code(409).send({
        error: 'the note moved',
        version: here.mirror.version(),
        text: here.mirror.text(),
        hint: 're-read the note and redo your ops against this text: somebody typed while you were thinking',
      })
    }

    const batch = { id: randomBytes(8).toString('hex'), ops: parsed.ops }
    // Injectable only for the tests: a suite that waited eight seconds for the honest answer would
    // be a suite nobody runs.
    const waitMs = typeof body.waitMs === 'number' ? Math.min(body.waitMs, APPLY_MS) : APPLY_MS
    const answer = await here.mirror.submit(batch, waitMs)

    if (answer === 'timeout') {
      return await reply.code(503).send({
        error: 'nobody is applying edits right now',
        hint: 'the session has no connected editor at the moment — retry in a few seconds',
      })
    }
    if (answer.failure !== undefined) {
      const { kind, op, needle } = answer.failure
      return await reply.code(422).send({
        error: kind === 'missing' ? 'anchor not found' : 'anchor is ambiguous',
        op,
        needle,
        matched: kind === 'missing' ? 0 : answer.failure.matched,
        version: here.mirror.version(),
        text: here.mirror.text(),
        hint: kind === 'missing'
          ? 'the text is not in the note as written: re-read and anchor on what is there'
          : 'include more surrounding text so the anchor matches exactly once',
      })
    }

    return await reply.send({
      version: here.mirror.version(),
      text: here.mirror.text(),
      applied: parsed.ops.map((_op, at) => ({ op: at, matched: 1 })),
    })
  })
```

Add `parseOps` to the imports from `../../shared/live-ops.js`.

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm vitest run tests/server --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Add the rate limit, with its test**

```ts
describe('the rate limit', () => {
  it('lets sixty requests a minute through and then says to slow down', async () => {
    const { app, id, token } = await sessionWith()
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({
        method: 'GET', url: `/api/live/${id}/text`, headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode, `request ${i}`).toBe(200)
    }
    const over = await app.inject({
      method: 'GET', url: `/api/live/${id}/text`, headers: { authorization: `Bearer ${token}` },
    })
    expect(over.statusCode).toBe(429)
    expect(over.json()).toMatchObject({ hint: expect.stringContaining('wait') })
    await app.close()
  })
})
```

And in `routes.ts`, a counter per session reset on a sliding minute, checked at the top of both agent routes:

```ts
  /** Sixty a minute per session: a program in a loop, and one note's worth of work. */
  const PER_MINUTE = 60
  const spent = new Map<string, { from: number; count: number }>()

  function tooFast(id: string): boolean {
    const at = now()
    const seen = spent.get(id)
    if (seen === undefined || at - seen.from >= 60_000) {
      spent.set(id, { from: at, count: 1 })
      return false
    }
    seen.count += 1
    return seen.count > PER_MINUTE
  }
```

```ts
    if (tooFast(id)) {
      return await reply.code(429).send({
        error: 'too many requests',
        hint: 'sixty a minute per session: wait and retry',
      })
    }
```

Note for the implementer: `now()` is already in scope in `routes.ts` (it is `deps.now ?? Date.now`), which is what makes this testable without waiting a minute.

- [ ] **Step 6: Run and commit**

```bash
pnpm vitest run tests/server --maxWorkers=2 && pnpm typecheck
git add -A
git commit -F - <<'MSG'
An agent can edit the session's note

Anchored ops, applied atomically by a connected browser, with every refusal written for the program
reading it: a stale version comes back with the current text so the agent can redo its own work, an
anchor that matched twice comes back with the count and a suggestion to send more context, and no
connected editor is a 503 that says to retry rather than a hang.

Sixty requests a minute per session, twenty ops a request. The caller is a program in a loop and
the person who notices it running away is the one whose note is being edited.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 7: The agent in the room, and the token in the panel

**Files:**
- Modify: `src/server/live/routes.ts`, `src/web/state/live.ts`, `src/web/live/LivePanel.tsx`, `src/web/live/live.css`
- Test: `tests/server/live-agent-routes.test.ts`

**Interfaces:**
- Consumes: `LiveStarted` from `src/web/live/api.js` — which gains `agentToken: string`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
  it('puts the agent in the presence list, so the owner can see it is in the room', async () => {
    const { app, id, token } = await sessionWith()
    await app.inject({
      method: 'POST',
      url: `/api/live/${id}/edit`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { ops: [{ append: 'x' }], waitMs: 20 },
    })
    const res = await app.inject({
      method: 'GET', url: `/api/live/${id}/text`, headers: { authorization: `Bearer ${token}` },
    })
    expect((res.json() as { editors: { name: string }[] }).editors)
      .toContainEqual({ name: 'agent', color: '#7a4fa3' })
    await app.close()
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/server/live-agent-routes.test.ts --maxWorkers=2`
Expected: FAIL — `editors` is empty.

- [ ] **Step 3: Announce the agent**

In `routes.ts`, where a batch is submitted:

```ts
    /*
     * The agent, in the room.
     *
     * Its edits are applied by somebody else's client and therefore wear that person's name, so
     * this is the only place it is visible — and the server can do it alone, because it holds the
     * `Awareness` and does not need a browser to be a participant. Purple: the guests choose from
     * amber, green, purple and brick, and this is the one a person cannot pick for themselves.
     */
    here.room.awareness.setLocalStateField('user', { name: 'agent', color: '#7a4fa3' })
```

Remove the agent's state again when the session ends — `shut()` already destroys the room, so nothing more is needed.

Note: `makeRoom` currently sets `awareness.setLocalState(null)` with the comment that the server is not a participant. Change that comment: it is a participant exactly when an agent is working, and the reason it holds no state before then is that an empty room should look empty.

- [ ] **Step 4: Carry the token to the panel**

`src/web/live/api.ts`: add `agentToken: string` to `LiveStarted`.

`src/web/live/LivePanel.tsx`, in `Running`, under the link row:

```tsx
        {session !== null && (
          <div class="ink-live-token">
            <span class="ink-live-token-label">Agent token</span>
            <span class="ink-live-token-value" onClick={() => { selectAll(tokenRef) }} ref={tokenRef}>
              {shown ? session.agentToken : '••••••••••••'}
            </span>
            <button type="button" class="ink-live-token-show" onClick={() => { setShown(!shown) }}>
              {shown ? 'Hide' : 'Show'}
            </button>
          </div>
        )}
```

with `const [shown, setShown] = useState(false)` and `const tokenRef = useRef<HTMLSpanElement>(null)`. Hidden by default: it is a credential, and a panel that shows one while somebody is sharing their screen is a panel that leaks it.

The CSS goes in `live.css` beside `.ink-live-who`, reusing `--ink-font-mono` and `--ink-r-sm`; no new vocabulary.

- [ ] **Step 5: Run everything**

```bash
pnpm typecheck && pnpm vitest run --maxWorkers=2 && pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -F - <<'MSG'
The agent is in the presence list, and its token is in the panel

Its edits are applied by somebody else's client and wear that person's name, so the presence list is
the only place an agent is visible — and the server can put it there alone, because it holds the
Awareness and needs no browser to be a participant.

The token is hidden until asked for: it is a credential, and a panel that shows one while somebody
is sharing their screen is a panel that leaks it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 8: The skill, and the e2e that is its proof

**Files:**
- Create: `skills/inkstone-live-doc/SKILL.md`, `tests/e2e/live-agent.spec.ts`
- Modify: `tests/e2e/server.mjs` (one fixture note)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the skill**

```markdown
---
name: inkstone-live-doc
description: Use when editing a note in an Inkstone live session — reading and changing a document somebody else has open in their editor, through the session's HTTP API.
---

# Editing a live Inkstone note

You have a session link and an agent token. The note is **open in somebody's editor right now** and
they are watching; your edits appear on their screen as you make them, and they can undo them.

## The loop

1. `GET {origin}/api/live/{id}/text` with `Authorization: Bearer {token}`.
   Answers `{ note, version, text, editors, applying }`.
2. Decide the smallest edits that do the job.
3. `POST {origin}/api/live/{id}/edit` with `{ "version": <from step 1>, "ops": [ … ] }`.
4. Read the answer: `200` carries the new `text` and `version`. Anything else tells you what to do.

## The ops

| | |
|---|---|
| `{"find": "exact text", "replace": "new text"}` | inline text, replaced in place |
| `{"insertAfterHeading": "Next week", "text": "- a new item"}` | markdown, inserted after that heading |
| `{"append": "## A new section\n\nbody"}` | markdown, at the end of the note |

`find` is **literal text**, not a pattern, and must match **exactly once**. It may span bold or
italic — what reads as one phrase is one phrase — but it may not cross a paragraph break.

## What will go wrong, and what to do

| | |
|---|---|
| `409 the note moved` | somebody typed while you were thinking. The body carries the current `text`: re-read it and redo your ops against it. Do not retry the same ops blind. |
| `422 anchor not found` | the text is not in the note as written. Re-read; do not guess. |
| `422 anchor is ambiguous` | your anchor matched more than once. Send more surrounding text. |
| `503 nobody is applying edits right now` | the editor is not connected at the moment — a backgrounded phone, a lost network. Wait a few seconds and retry. |
| `429 too many requests` | sixty a minute per session. Wait. |

## Rules

- **Never send the whole document.** There is no endpoint for it, and it would throw away what the
  people in the session are typing. Anchored ops only.
- **Send `version`.** An unconditional edit will apply on top of somebody's sentence.
- **Twenty ops a request, 64 KB of body.** Split larger work and re-read between batches.
- **You cannot save or commit.** The person hosting the session does that when they end it; until
  then nothing you write is in their git history. Do not ask for it and do not wait for it.
- **You are in the presence list as `agent`.** They can see you are there.
- **One note.** The session is a single note; there is no listing, no search and no other file.
```

- [ ] **Step 2: Write the failing e2e**

```ts
import { expect, test, type Page } from '@playwright/test'

/**
 * The API, driven as the agent, against a real session in a real browser.
 *
 * This is the only test that proves the whole path: the owner's editor keeps the mirror, the server
 * reads it without a schema, an op parked by HTTP is applied by that editor as a local transaction,
 * and the note holds the result after the session ends. Everything else about the agent API is unit
 * tested; none of it would catch the two ends disagreeing.
 */
test.setTimeout(120_000)

async function signIn(page: Page, note: string, expectText: string) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText(expectText, { timeout: 15_000 })
}

test('an agent reads the note, edits it, and the owner keeps the result', async ({ page, request }) => {
  await signIn(page, 'live-agent-crepe.md', 'Before.')

  const row = page.locator('.ink-tree-row').filter({ hasText: 'live-agent-crepe.md' })
  await row.hover()
  await page.getByRole('button', { name: 'Actions for live-agent-crepe.md' }).click()
  await page.getByText('Live share…').click()
  await page.locator('.ink-share').getByRole('button', { name: 'Start' }).click()
  const link = page.locator('.ink-share-url .ink-share-urltext')
  await expect(link).toContainText('/live/', { timeout: 15_000 })
  const id = (await link.innerText()).trim().split('/live/')[1]!
  await page.getByRole('button', { name: 'Show' }).click()
  const token = (await page.locator('.ink-live-token-value').innerText()).trim()
  await page.getByRole('button', { name: 'Close live share' }).click()

  const auth = { authorization: `Bearer ${token}` }

  // Read: the mirror is there without the agent touching the editor.
  const read = await request.get(`/api/live/${id}/text`, { headers: auth })
  expect(read.ok(), await read.text()).toBe(true)
  const first = await read.json() as { text: string; version: number; applying: boolean }
  expect(first.text).toContain('Before.')
  expect(first.applying).toBe(true)

  // Edit: anchored, conditional, and visible on the owner's screen.
  const edited = await request.post(`/api/live/${id}/edit`, {
    headers: auth,
    data: { version: first.version, ops: [{ find: 'Before.', replace: 'Before. The agent was here.' }] },
  })
  expect(edited.ok(), await edited.text()).toBe(true)
  await expect(page.locator('.ink-doc')).toContainText('The agent was here.', { timeout: 15_000 })

  // And the refusals say what they are supposed to say.
  const stale = await request.post(`/api/live/${id}/edit`, {
    headers: auth,
    data: { version: 0, ops: [{ append: 'x' }] },
  })
  expect(stale.status()).toBe(409)
  expect(await stale.json()).toMatchObject({ error: 'the note moved' })

  const missing = await request.post(`/api/live/${id}/edit`, {
    headers: auth,
    data: { ops: [{ find: 'nothing like this is in the note', replace: 'x' }] },
  })
  expect(missing.status()).toBe(422)
  expect(await missing.json()).toMatchObject({ error: 'anchor not found', matched: 0 })

  const ambiguous = await request.post(`/api/live/${id}/edit`, {
    headers: auth,
    data: { ops: [{ find: '.', replace: '!' }] },
  })
  expect(ambiguous.status()).toBe(422)
  expect(await ambiguous.json()).toMatchObject({ error: 'anchor is ambiguous' })

  // The token is the credential, and the session id is not it.
  const wrong = await request.get(`/api/live/${id}/text`, { headers: { authorization: `Bearer ${id}` } })
  expect(wrong.status()).toBe(401)

  // Ending writes the agent's work into the note.
  await row.hover()
  await page.getByRole('button', { name: 'Actions for live-agent-crepe.md' }).click()
  await page.getByRole('menuitem', { name: /^Live · / }).click()
  await page.getByRole('button', { name: 'End session' }).click()
  await expect(page.locator('.ink-share')).toContainText('Session ended', { timeout: 15_000 })

  const saved = await page.evaluate(async () => {
    const res = await fetch(`/api/file?path=${encodeURIComponent('notes/live-agent-crepe.md')}`)
    return (await res.json() as { content: string }).content
  })
  expect(saved, 'the agent\'s edit was not saved').toContain('The agent was here.')
})
```

- [ ] **Step 3: Add the fixture**

In `tests/e2e/server.mjs`, beside the other live fixtures:

```js
fs.writeFileSync(path.join(root, 'notes', 'live-agent-crepe.md'), 'Before.\n\nAfter.\n')
```

- [ ] **Step 4: Run it and watch it fail, then pass**

Run: `pnpm build && pnpm exec playwright test tests/e2e/live-agent.spec.ts --reporter=line`
Expected before Tasks 3-7 are in: FAIL. With them: PASS.

If `applying` is `false` on the first read, the editor has not attached its op consumer — check Task 5 Step 4. If the edit times out as 503, the same.

- [ ] **Step 5: Run everything**

```bash
pnpm typecheck && pnpm vitest run --maxWorkers=2 && pnpm exec playwright test --reporter=line
```

- [ ] **Step 6: Commit, bump, deploy**

```bash
git add -A
git commit -F - <<'MSG'
A skill for the agent, and the e2e that proves the whole path

The skill is written for a program rather than a person: the loop, the three ops, the five refusals
and what each one means, and the four rules it will otherwise break — never send the whole document,
always send the version, you cannot commit, one note.

The e2e drives the API as the agent against a real session in a real browser: the mirror is readable
without the agent touching the editor, an op parked over HTTP lands on the owner's screen, each
refusal says what it is supposed to say, the session id is not the token, and ending the session
writes the agent's work into the note.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

Then the release, the way every release in this repository goes: `npm version` without a tag, a
commit whose subject says what the release contains, push the branch, `node scripts/sync-public.mjs
--push`, and the deploy — `deploy/DEPLOYMENT.md` has the command and the host. The build takes about
ten minutes on the server, and a poll that treats an unreachable answer as "the version changed"
will tell you it is live twice before it is.

---

## Self-review

**Spec coverage.** Every section of `docs/design/live-agent.md` has a task: the deletion (1), the op types and their rules (2), the mirror and the read (3), the anchor rules (4), the client's hands and the undo trade-off (5), the write endpoint with all five refusals and the limits (6), the presence entry and the token (7), the skill and the end-to-end proof (8). The spec's "what this cannot do" needs no task — it is the absence of one.

**Placeholders.** None: every step carries the code or the exact edit. One exception is marked as such — Task 1 Step 2's `RightPanel` rewrite shows the shape and says to read the real file for the history component's actual name rather than pasting over it.

**Type consistency.** `LiveOp`, `LiveBatch`, `LiveResult`, `LiveFailure` and `MAX_OPS` are declared once in Task 2 and used under those names in 3, 5 and 6. `MIRROR`/`INBOX`/`RESULTS` are declared in Task 3 and moved to `src/shared/live-wire.ts` in Task 5 Step 1, with the server re-exporting them so Task 3's test keeps passing. `watchMirror` returns `Mirror` with `text`/`version`/`submit`/`stop`, used in 3, 6 and 7. `keepMirror(wire, read)` and `serveAgent(wire, ctx, view)` are declared in Task 5 and called only from `CrepeEditor`. `findText`/`findHeading` return `Hit[]` in Task 4 and are consumed under that name in Task 5.

**One gap found and closed while reviewing:** Task 3's test asserts `applying: false` with no browser attached, and Task 3's route computes it from `here.seats`. Task 8's e2e asserts `applying: true` with one. Both hold.
