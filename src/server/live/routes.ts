import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import * as Y from 'yjs'
import type { LiveConfig } from '../config.js'
import { watchMirror, type Mirror } from './mirror.js'
import { forget, greet, makeRoom, receive, relay, type Room, type Wire } from './protocol.js'
import { parseOps } from '../../shared/live-ops.js'
import { LiveStore, MAX_GUESTS, type LiveSession } from './store.js'

/**
 * The routes a live session needs, which is four and a socket.
 *
 * Starting one is checked against the account that owns the notes, exactly as sharing is and for
 * the same reason: a socket anybody may write through is only safe to run if somebody is
 * answerable for its existing. Joining one needs nothing at all — a link that needs an account is
 * not a link.
 *
 * **The owner's socket is told apart by a ticket.** A browser cannot put a header on a WebSocket
 * handshake, so the credential the REST routes use is unavailable here; `POST /api/live` hands back
 * a random ticket and the owner's socket carries it in the query. It grants one thing — to be
 * treated as the owner of a session this account started and can end — and it dies with the
 * session. The alternative was a session cookie, which the GitHub deployment does not have.
 */

/** Close codes above the 4000 line, which is the range an application may use. */
const CLOSE = {
  gone: 4404,
  full: 4409,
  held: 4423,
  ended: 4000,
} as const

export interface LiveRoutesDeps {
  config: LiveConfig | null
  /** Injectable so the tests never reach api.github.com. */
  fetch?: typeof globalThis.fetch
  /** Injectable so the tests drive the clocks rather than waiting for them. */
  now?: () => number
  sweepEveryMs?: number
}

interface Seat {
  socket: WebSocket
  isOwner: boolean
}

interface Live {
  room: Room
  ticket: string
  /**
   * The agent's own credential.
   *
   * Not the session id: that is a capability to edit in a browser and gets pasted into chat
   * windows, and an API token is scriptable and logged. One per session, dead with it. See
   * `docs/design/live-agent.md`.
   */
  agentToken: string
  mirror: Mirror
  stopRelay: () => void
  /** Every socket in the room, so an ending can close them with a reason. */
  seats: Map<Wire, Seat>
}

export function registerLiveRoutes(app: FastifyInstance, deps: LiveRoutesDeps): void {
  if (deps.config === null) return
  const config: LiveConfig = deps.config

  const now = deps.now ?? (() => Date.now())
  const store = new LiveStore<Y.Doc>({ now, makeDoc: () => new Y.Doc() })
  /** What the registry deliberately knows nothing about: the wire, the ticket and the sockets. */
  const rooms = new Map<string, Live>()

  /** The room for a session, made once. The ticket is made with it and lives exactly as long. */
  function live(session: LiveSession<Y.Doc>): Live {
    const found = rooms.get(session.id)
    if (found !== undefined) return found
    const room = makeRoom(session.doc)
    const made: Live = {
      room,
      ticket: randomBytes(24).toString('base64url'),
      agentToken: randomBytes(24).toString('base64url'),
      mirror: watchMirror(session.doc),
      stopRelay: relay(room),
      seats: new Map(),
    }
    rooms.set(session.id, made)
    return made
  }

  /**
   * Close a room, or empty it.
   *
   * `held` sends the guests home and keeps everything else: the document is the owner's work and
   * they may still come back for it. Anything else is the end, and then the relay and the document
   * go too — a `Y.Doc` nobody detaches keeps its observers alive.
   */
  function shut(id: string, why: 'owner' | 'idle' | 'expired' | 'dropped' | 'held'): void {
    const found = rooms.get(id)
    if (found === undefined) return
    for (const [wire, seat] of found.seats) {
      if (why === 'held' && seat.isOwner) continue
      try {
        seat.socket.close(why === 'held' ? CLOSE.held : CLOSE.ended, why)
      } catch { /* already gone: its close handler has run, or is about to */ }
      if (why === 'held') found.seats.delete(wire)
    }
    if (why === 'held') return
    found.mirror.stop()
    found.stopRelay()
    found.room.doc.destroy()
    rooms.delete(id)
  }

  /**
   * Who this request is, which is one of two questions depending on the deployment.
   *
   * The vault has a password and a session cookie, and whoever holds it is the owner — there is
   * one. The GitHub route has no session of this server's own, so the token the browser is already
   * using is checked against GitHub and the login must be the one named in `GITHUB_OWNER`. The
   * same shape as `routes/upload.ts`, and for the same reason.
   */
  async function ownerOf(req: FastifyRequest): Promise<string | null> {
    const authenticated = (app as unknown as { isAuthenticated?: (r: FastifyRequest) => boolean })
      .isAuthenticated
    if (authenticated?.(req) === true) return 'vault'

    const named = config.owner
    if (named === null) return null
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    if (token === undefined) return null
    const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
    try {
      const res = await doFetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      })
      if (!res.ok) return null
      const user = await res.json() as { login?: string }
      return user.login === named ? named : null
    } catch {
      // Cannot ask GitHub who this is, so cannot say yes.
      return null
    }
  }

  async function ownerOr401(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const owner = await ownerOf(req)
    if (owner === null) {
      await reply.code(401).send({ error: 'Only the account these notes belong to can start one.' })
      return null
    }
    return owner
  }

  const guests = (session: LiveSession<Y.Doc>) => session.members.filter((m) => !m.isOwner).length

  /** Start one, or hand back the one already running for this note. */
  app.post('/api/live', async (req, reply) => {
    const owner = await ownerOr401(req, reply)
    if (owner === null) return
    const body = req.body as { path?: unknown; title?: unknown } | undefined
    const notePath = typeof body?.path === 'string' ? body.path : ''
    const title = typeof body?.title === 'string' ? body.title : ''
    if (notePath === '' || title === '') {
      return await reply.code(400).send({ error: 'which note' })
    }

    const session = store.open({ path: notePath, title, owner })
    if (session === 'busy') {
      return await reply.code(409).send({
        error: 'A session is already running for another note.',
        path: store.of(owner)?.path ?? null,
      })
    }
    return await reply.send({
      id: session.id,
      path: session.path,
      title: session.title,
      ticket: live(session).ticket,
      agentToken: live(session).agentToken,
      // Work that outlived the owner's connection. The browser asks before it replaces what is on
      // screen, because these edits were made while it was not looking.
      reclaim: session.keepUntil !== null,
    })
  })

  /**
   * The session this account is running, asked when the app opens.
   *
   * This is how a reload lands back inside a session rather than beside it, and how a dropped one
   * that is being held gets claimed. One request and no list: there is at most one.
   */
  app.get('/api/live/mine', async (req, reply) => {
    const owner = await ownerOf(req)
    const mine = owner === null ? null : store.of(owner)
    if (mine === null) return await reply.send({ session: null })
    return await reply.send({
      session: {
        id: mine.id,
        path: mine.path,
        title: mine.title,
        ticket: live(mine).ticket,
        agentToken: live(mine).agentToken,
        reclaim: mine.keepUntil !== null,
        guests: guests(mine),
      },
    })
  })

  /**
   * What a guest is told before being asked for a name.
   *
   * One sentence for every way a link can fail — ended, held, never existed — because telling a
   * stranger *which* one it was tells them something about somebody else's notes.
   */
  app.get('/api/live/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = store.get(id)
    if (session === null || session.keepUntil !== null) {
      return await reply.code(404).send({ error: 'This link does not work. Ask for a new one.' })
    }
    return await reply.send({
      title: session.title,
      // A vault deployment has one owner and no name for them, and `null` is the honest answer.
      owner: session.owner === 'vault' ? null : session.owner,
      guests: guests(session),
      full: guests(session) >= MAX_GUESTS,
    })
  })

  /** Stop. Only the account that started it, and not an error twice. */
  app.delete('/api/live/:id', async (req, reply) => {
    const owner = await ownerOr401(req, reply)
    if (owner === null) return
    const { id } = req.params as { id: string }
    const session = store.get(id)
    if (session === null) return await reply.send({ ended: false })
    if (session.owner !== owner) return await reply.code(403).send({ error: 'Not your session.' })
    store.end(id)
    shut(id, 'owner')
    return await reply.send({ ended: true })
  })

  /**
   * Whose session this is, for an agent.
   *
   * The same answer for "not a session" and "not your token" where it can be: which one it was is a
   * fact about somebody else's notes.
   */
  function agentOf(req: FastifyRequest, id: string): Live | null {
    const found = rooms.get(id)
    if (found === undefined) return null
    const given = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    return given !== undefined && given === found.agentToken ? found : null
  }

  const NO_SESSION = {
    error: 'no such session',
    hint: 'the session ended, or the id is wrong: ask whoever gave you the link for a new one',
  }
  const NOT_YOUR_TOKEN = {
    error: 'not this session\u2019s token',
    hint: 'use the agent token from the owner\u2019s Live share panel, not the session id',
  }

  /** Where both agent routes start: the session, the token, and the refusals for each. */
  function agentReply(req: FastifyRequest, id: string): { session: LiveSession<Y.Doc>; here: Live } | { code: 404 | 401; body: typeof NO_SESSION } {
    const session = store.get(id)
    if (session === null) return { code: 404, body: NO_SESSION }
    const here = agentOf(req, id)
    if (here === null) return { code: 401, body: NOT_YOUR_TOKEN }
    return { session, here }
  }

  /**
   * The note, as text.
   *
   * Answered off the mirror, so it costs nothing and works when the only client in the session is a
   * phone with its timers throttled — see `mirror.ts` for why that matters.
   */
  app.get('/api/live/:id/text', async (req, reply) => {
    const { id } = req.params as { id: string }
    const found = agentReply(req, id)
    if ('code' in found) return await reply.code(found.code).send(found.body)
    if (tooFast(id)) return await reply.code(429).send(TOO_FAST)
    const { session, here } = found
    return await reply.send({
      note: session.path,
      version: here.mirror.version(),
      text: here.mirror.text(),
      editors: [...here.room.awareness.getStates().values()]
        .map((state) => (state as { user?: { name?: unknown; color?: unknown } }).user)
        .filter((user): user is { name: string; color: string } =>
          typeof user?.name === 'string' && typeof user.color === 'string'),
      // Whether anybody is in a position to apply an edit: the one thing an agent cannot find out
      // for itself, and the difference between "retry" and "give up".
      applying: here.seats.size > 0,
    })
  })

  /** The one colour the guest page does not offer, so a purple name is always the agent. */
  const AGENT_COLOR = '#7a4fa3'
  /** Eight seconds: long enough for a browser that is awake, short enough to be an answer. */
  const APPLY_MS = 8 * 1000
  /** Sixty a minute per session: a program in a loop, and one note's worth of work. */
  const PER_MINUTE = 60
  const spent = new Map<string, { from: number; count: number }>()

  /**
   * Whether this session has had its minute's worth.
   *
   * Per session rather than per address: the thing worth protecting is the note and the person
   * watching it being edited, and an agent on a laptop and one in a data centre cost the same.
   */
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

  const TOO_FAST = {
    error: 'too many requests',
    hint: 'sixty a minute per session: wait and retry',
  }

  /**
   * Edit the note.
   *
   * Anchored ops, applied by a browser, atomically. Every refusal carries the current text and a
   * sentence saying what to do with it, because the caller is a program that can fix its own
   * request if it is told how. See `docs/design/live-agent.md`.
   */
  app.post('/api/live/:id/edit', async (req, reply) => {
    const { id } = req.params as { id: string }
    const found = agentReply(req, id)
    if ('code' in found) return await reply.code(found.code).send(found.body)
    if (tooFast(id)) return await reply.code(429).send(TOO_FAST)
    const { here } = found

    const body = (req.body ?? {}) as { ops?: unknown; version?: unknown; waitMs?: unknown }
    // `body.ops ?? body` so a caller that sent a bare array, or a document, is told the same thing.
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

    /*
     * The agent, in the room.
     *
     * Its edits are applied by somebody else's client and therefore wear that person's name, so
     * this is the only place it is visible — and the server can do it alone, because it holds the
     * `Awareness` and does not need a browser to be a participant. Purple is the one colour a guest
     * cannot pick for themselves, so a purple name in the list is always this.
     */
    // `setLocalState`, not `setLocalStateField`: the latter is a no-op while the local state is
    // null, which is exactly how `makeRoom` leaves it so that an empty room has an empty presence
    // list. A field setter that silently does nothing is how the agent stayed invisible once.
    here.room.awareness.setLocalState({ user: { name: 'agent', color: AGENT_COLOR } })

    const batch = { id: randomBytes(8).toString('hex'), ops: parsed.ops }
    // `waitMs` is for the tests only: a suite that waited the honest eight seconds for the
    // nobody-is-applying answer is a suite nobody runs. Capped, so it cannot be used to hold a
    // request open.
    const waitMs = typeof body.waitMs === 'number' && body.waitMs > 0
      ? Math.min(body.waitMs, APPLY_MS)
      : APPLY_MS
    const answer = await here.mirror.submit(batch, waitMs)

    if (answer === 'timeout') {
      return await reply.code(503).send({
        error: 'nobody is applying edits right now',
        hint: 'the session has no connected editor at the moment — wait a few seconds and retry',
      })
    }

    const failed = answer.failure
    if (failed !== undefined) {
      return await reply.code(422).send({
        error: failed.kind === 'missing' ? 'anchor not found' : 'anchor is ambiguous',
        op: failed.op,
        needle: failed.needle,
        matched: failed.kind === 'missing' ? 0 : failed.matched,
        version: here.mirror.version(),
        text: here.mirror.text(),
        hint: failed.kind === 'missing'
          ? 'that text is not in the note as written: re-read it and anchor on what is there'
          : 'include more of the surrounding text so the anchor matches exactly once',
      })
    }

    return await reply.send({
      version: here.mirror.version(),
      text: here.mirror.text(),
      applied: parsed.ops.map((_op, at) => ({ op: at, matched: 1 })),
    })
  })

  /**
   * The wire.
   *
   * No body and no headers worth reading: the id says which room, the ticket says whether this is
   * the owner, and everything after that is `protocol.ts` — deliberately the only part of this
   * server that touches a document.
   */
  app.get('/ws/live/:id', { websocket: true }, (socket: WebSocket, req) => {
    const { id } = req.params as { id: string }
    const session = store.get(id)
    if (session === null) {
      socket.close(CLOSE.gone, 'gone')
      return
    }
    const here = live(session)
    const ticket = (req.query as { t?: string } | undefined)?.t
    const isOwner = typeof ticket === 'string' && ticket === here.ticket
    const member = store.join(id, isOwner ? 'owner' : 'guest')
    if (typeof member === 'string') {
      socket.close(CLOSE[member], member)
      return
    }

    const room = here.room
    const wire: Wire = {
      send: (data) => {
        if (socket.readyState === socket.OPEN) socket.send(data)
      },
    }
    room.wires.add(wire)
    here.seats.set(wire, { socket, isOwner })

    /**
     * Which Yjs clients announced themselves down this socket.
     *
     * Needed only to take their caret and their name away when it closes. The origin of an
     * awareness update is the wire it arrived on — see `protocol.ts` — so this is the attribution
     * the protocol already carries, rather than a guess from the order ids appeared in.
     */
    const mine = new Set<number>()
    const onAwareness = (
      changed: { added: number[]; updated: number[] },
      origin: unknown,
    ) => {
      if (origin !== wire) return
      for (const client of [...changed.added, ...changed.updated]) mine.add(client)
    }
    room.awareness.on('update', onAwareness)

    greet(room, wire)

    socket.on('message', (data: ArrayBuffer | Buffer | Buffer[]) => {
      const bytes = Array.isArray(data)
        ? new Uint8Array(Buffer.concat(data))
        : data instanceof Buffer
          ? new Uint8Array(data)
          : new Uint8Array(data)
      // The idle clock is measured from changes to the document, not from traffic: a room full of
      // moving carets is an idle room.
      if (receive(room, wire, bytes)) store.touch(id)
    })

    let left = false
    const bye = () => {
      if (left) return
      left = true
      room.awareness.off('update', onAwareness)
      forget(room, wire, [...mine])
      here.seats.delete(wire)
      store.leave(id, member)
    }
    socket.on('close', bye)
    socket.on('error', bye)
  })

  /**
   * The clocks, run on a timer rather than on a request.
   *
   * A session nobody is touching is exactly the one no request will arrive for, so sweeping lazily
   * would leave an abandoned room running until somebody happened to open another one.
   */
  const timer = setInterval(() => {
    const { held, ended } = store.sweep()
    for (const session of held) shut(session.id, 'held')
    for (const { session, why } of ended) shut(session.id, why)
  }, deps.sweepEveryMs ?? 30 * 1000)
  timer.unref?.()
  app.addHook('onClose', async () => { clearInterval(timer) })
}
