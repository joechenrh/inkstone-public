import { signal, type Signal } from '@preact/signals'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync'
import * as Y from 'yjs'

/**
 * The browser's end of a live session.
 *
 * Deliberately not `y-websocket`: that package brings its own reconnection, its own room naming and
 * a service worker story this application has no use for, and the protocol it speaks is two message
 * kinds. The server's end is `src/server/live/protocol.ts` and the two files should be read
 * together — they are the same wire from either side.
 *
 * **The status is the interface.** Every way a session can fail has a sentence somebody reads, so
 * this reports one of a small set of states rather than throwing: a socket that closes because the
 * room is full is not an error to be handled, it is a page that says the room is full.
 */

const SYNC = 0
const AWARENESS = 1

/** What the server says when it closes a socket on purpose. See `live/routes.ts`. */
const CLOSE = {
  ended: 4000,
  gone: 4404,
  full: 4409,
  held: 4423,
} as const

export type LiveStatus =
  /** Opening, or opening again. Nothing is editable yet. */
  | 'connecting'
  /** Connected and in sync. */
  | 'live'
  /** The connection went and is being retried. On the owner's side this is the grace period. */
  | 'retrying'
  /** The owner ended it, or a clock did. */
  | 'ended'
  /** Eight guests are already in. */
  | 'full'
  /** No such session — ended long ago, or never existed. */
  | 'gone'
  /** The owner dropped and did not come back. The document is being kept for them. */
  | 'held'

export interface LiveUser {
  name: string
  color: string
}

export interface LiveWire {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  readonly status: Signal<LiveStatus>
  /** Everybody with a name and a colour, the owner first. Drives the dots and the list. */
  readonly peers: Signal<LiveUser[]>
  destroy: () => void
}

export interface LiveWireOptions {
  id: string
  /** The owner's, from `POST /api/live`. Absent for a guest, which is most people. */
  ticket?: string
  user: LiveUser
  /** Injectable so the tests are a pair of fakes rather than a pair of processes. */
  socketFor?: (url: string) => WebSocket
  /** Injectable for the same reason: a test should not wait a second to see a retry. */
  retryMs?: number
}

export function connectLive(options: LiveWireOptions): LiveWire {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const status = signal<LiveStatus>('connecting')
  const peers = signal<LiveUser[]>([])

  const url = () => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ticket = options.ticket === undefined ? '' : `?t=${encodeURIComponent(options.ticket)}`
    return `${protocol}//${location.host}/live-ws/${encodeURIComponent(options.id)}${ticket}`
  }

  let socket: WebSocket | null = null
  let closed = false
  let retry = 0

  const send = (bytes: Uint8Array) => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(bytes)
  }

  const readPeers = () => {
    const seen: LiveUser[] = []
    for (const state of awareness.getStates().values()) {
      const user = (state as { user?: Partial<LiveUser> } | undefined)?.user
      if (typeof user?.name === 'string' && typeof user.color === 'string') {
        seen.push({ name: user.name, color: user.color })
      }
    }
    peers.value = seen
  }

  /** Document updates out. The origin tells us not to echo what the server just told us. */
  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === 'server') return
    const message = encoding.createEncoder()
    encoding.writeVarUint(message, SYNC)
    writeUpdate(message, update)
    send(encoding.toUint8Array(message))
  }

  const onAwarenessUpdate = (
    changed: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    readPeers()
    if (origin === 'server') return
    const ids = [...changed.added, ...changed.updated, ...changed.removed]
    const message = encoding.createEncoder()
    encoding.writeVarUint(message, AWARENESS)
    encoding.writeVarUint8Array(message, encodeAwarenessUpdate(awareness, ids))
    send(encoding.toUint8Array(message))
  }

  doc.on('update', onDocUpdate)
  awareness.on('update', onAwarenessUpdate)
  awareness.setLocalStateField('user', options.user)

  function open(): void {
    if (closed) return
    const made = (options.socketFor ?? ((at: string) => new WebSocket(at)))(url())
    made.binaryType = 'arraybuffer'
    socket = made

    made.onopen = () => {
      retry = 0
      status.value = 'live'
      /*
       * Our own step one, which is what actually fetches the document.
       *
       * The server greets a new socket with *its* state vector — a question about what we have.
       * The content travels the other way only once we ask the same question back, so a client
       * that does not send this sits looking at an empty note while everybody else types.
       */
      const hello = encoding.createEncoder()
      encoding.writeVarUint(hello, SYNC)
      writeSyncStep1(hello, doc)
      made.send(encoding.toUint8Array(hello))

      // And say who we are, so the others' presence lists fill in without waiting for a keystroke.
      const who = encoding.createEncoder()
      encoding.writeVarUint(who, AWARENESS)
      encoding.writeVarUint8Array(who, encodeAwarenessUpdate(awareness, [doc.clientID]))
      made.send(encoding.toUint8Array(who))
    }

    made.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!(data instanceof ArrayBuffer)) return
      try {
        const decoder = decoding.createDecoder(new Uint8Array(data))
        const kind = decoding.readVarUint(decoder)
        if (kind === SYNC) {
          const reply = encoding.createEncoder()
          encoding.writeVarUint(reply, SYNC)
          // `'server'` as the origin: what came from the wire must not go straight back out.
          readSyncMessage(decoder, reply, doc, 'server')
          if (encoding.length(reply) > 1) send(encoding.toUint8Array(reply))
        } else if (kind === AWARENESS) {
          applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), 'server')
        }
      } catch {
        // A message we cannot read is not worth taking the session down for.
      }
    }

    made.onclose = (event: CloseEvent) => {
      socket = null
      if (closed) return
      // Everyone but us: our own entry is re-announced on the next open, and the others are only
      // still on screen because their departure was announced over a socket that is now gone.
      removeAwarenessStates(
        awareness,
        [...awareness.getStates().keys()].filter((id) => id !== doc.clientID),
        'disconnect',
      )
      const said = event.code
      if (said === CLOSE.gone) { status.value = 'gone'; return }
      if (said === CLOSE.full) { status.value = 'full'; return }
      if (said === CLOSE.held) { status.value = 'held'; return }
      if (said === CLOSE.ended) { status.value = 'ended'; return }
      // Anything else is the network rather than a decision, and the answer to the network is to
      // try again. On the owner's side this is what the grace period is for.
      status.value = 'retrying'
      retry += 1
      const wait = Math.min((options.retryMs ?? 800) * retry, 8000)
      setTimeout(open, wait)
    }
  }

  open()

  return {
    doc,
    awareness,
    status,
    peers,
    destroy: () => {
      closed = true
      /*
       * Goodbye first, and only then stop listening.
       *
       * Clearing the local state is what tells the room we have gone, and it travels by the very
       * handler below — so detaching before clearing sends nothing, and everybody else keeps our
       * caret and our name on screen for the rest of the session. The server tidies up after a
       * socket that *closes*, which hid this for every case except the one where the page lets go
       * of the session without the socket going down with it.
       */
      awareness.setLocalState(null)
      doc.off('update', onDocUpdate)
      awareness.off('update', onAwarenessUpdate)
      try { socket?.close() } catch { /* already gone */ }
      socket = null
      doc.destroy()
    },
  }
}
