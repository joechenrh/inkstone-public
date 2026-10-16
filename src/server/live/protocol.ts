import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

/**
 * The wire, and the whole of what this server understands about a shared document.
 *
 * Two message kinds, which is the protocol `y-websocket` speaks and therefore the one
 * `y-prosemirror` on the other end expects. A sync message carries document updates; an awareness
 * message carries who is here, what they are called and where their caret is. **Both are opaque**:
 * this file merges bytes into a `Y.Doc` and hands bytes on. It cannot read the text, and that is
 * the point — reading it would mean a ProseMirror schema, which would mean Milkdown in Node.
 *
 * Written here rather than taken from `y-websocket`'s own server: that package keeps its own
 * registry of documents keyed by name, and this server already has one with the caps, the clocks
 * and the owner in it (`store.ts`). Two registries disagreeing about who is in a room is a class
 * of bug worth a hundred lines to avoid.
 */

const SYNC = 0
const AWARENESS = 1

/** What a socket needs to be, so the tests can be a pair of arrays rather than a pair of servers. */
export interface Wire {
  send: (data: Uint8Array) => void
}

export interface Room {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  readonly wires: Set<Wire>
}

export function makeRoom(doc: Y.Doc): Room {
  const awareness = new awarenessProtocol.Awareness(doc)
  /*
   * No state until there is something to say.
   *
   * The server is not a participant while nobody is using it as one: announcing a name here would
   * put a ghost in an empty room's presence list. It becomes one exactly when an agent edits
   * through the API, and `live/routes.ts` is where that name is set — the `Awareness` is the
   * server's, which is why an agent needs no browser to be visible in the room.
   */
  awareness.setLocalState(null)
  return { doc, awareness, wires: new Set() }
}

/**
 * The first thing said on a new connection: what the server has, and who is here.
 *
 * Step one of the sync is a *question* — "here is my state vector, send me what I am missing" —
 * and the client answers it with step two. The awareness message is sent unprompted because a
 * newcomer's presence list would otherwise stay empty until somebody moved their caret.
 */
export function greet(room: Room, wire: Wire): void {
  const sync = encoding.createEncoder()
  encoding.writeVarUint(sync, SYNC)
  syncProtocol.writeSyncStep1(sync, room.doc)
  wire.send(encoding.toUint8Array(sync))

  const present = [...room.awareness.getStates().keys()]
  if (present.length > 0) {
    const who = encoding.createEncoder()
    encoding.writeVarUint(who, AWARENESS)
    encoding.writeVarUint8Array(who, awarenessProtocol.encodeAwarenessUpdate(room.awareness, present))
    wire.send(encoding.toUint8Array(who))
  }
}

/**
 * One message in.
 *
 * Returns whether the document changed, which is the signal the idle clock is measured from —
 * an awareness message is somebody moving their mouse, and a room full of moving mice with nobody
 * typing is an idle room.
 *
 * A malformed message is dropped rather than thrown: this socket is reachable by anyone holding
 * the link, and a stranger's bad bytes must not take the room down with them.
 */
export function receive(room: Room, wire: Wire, data: Uint8Array): boolean {
  try {
    const decoder = decoding.createDecoder(data)
    const kind = decoding.readVarUint(decoder)
    if (kind === SYNC) {
      const reply = encoding.createEncoder()
      encoding.writeVarUint(reply, SYNC)
      const before = Y.encodeStateVector(room.doc)
      // `null` as the transaction origin would be indistinguishable from a local change; the wire
      // is named so the update handler can send everyone *else* the result.
      syncProtocol.readSyncMessage(decoder, reply, room.doc, wire)
      // Step one asks a question, and the answer is the only thing worth sending back. The other
      // sync messages leave the encoder holding nothing but the message kind.
      if (encoding.length(reply) > 1) wire.send(encoding.toUint8Array(reply))
      return !equal(before, Y.encodeStateVector(room.doc))
    }
    if (kind === AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        decoding.readVarUint8Array(decoder),
        wire,
      )
    }
    return false
  } catch {
    return false
  }
}

/**
 * Relay what changed to everyone but whoever caused it.
 *
 * Attached once per room. The `origin` of a Yjs transaction is the wire the update arrived on, so
 * the sender is not sent their own bytes back — they already have them, and echoing is how a
 * collaborative editor ends up in a loop.
 */
export function relay(room: Room): () => void {
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    const message = encoding.createEncoder()
    encoding.writeVarUint(message, SYNC)
    syncProtocol.writeUpdate(message, update)
    const payload = encoding.toUint8Array(message)
    for (const wire of room.wires) {
      if (wire !== origin) wire.send(payload)
    }
  }
  const onAwareness = (
    changed: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const ids = [...changed.added, ...changed.updated, ...changed.removed]
    const message = encoding.createEncoder()
    encoding.writeVarUint(message, AWARENESS)
    encoding.writeVarUint8Array(message, awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids))
    const payload = encoding.toUint8Array(message)
    for (const wire of room.wires) {
      if (wire !== origin) wire.send(payload)
    }
  }
  room.doc.on('update', onUpdate)
  room.awareness.on('update', onAwareness)
  return () => {
    room.doc.off('update', onUpdate)
    room.awareness.off('update', onAwareness)
  }
}

/**
 * Somebody's socket went.
 *
 * Their awareness entry goes with it, or their caret and their name stay on everybody else's
 * screen for as long as the session lasts — a presence list that lists the departed is worse than
 * none.
 */
export function forget(room: Room, wire: Wire, clients: number[]): void {
  room.wires.delete(wire)
  if (clients.length > 0) {
    awarenessProtocol.removeAwarenessStates(room.awareness, clients, 'disconnect')
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
