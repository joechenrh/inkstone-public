import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import * as Y from 'yjs'
import type { LiveConfig } from '../config.js'
import { forget, greet, makeRoom, receive, relay, type Room, type Wire } from './protocol.js'
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
   * The wire.
   *
   * No body and no headers worth reading: the id says which room, the ticket says whether this is
   * the owner, and everything after that is `protocol.ts` — deliberately the only part of this
   * server that touches a document.
   */
  app.get('/live-ws/:id', { websocket: true }, (socket: WebSocket, req) => {
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
