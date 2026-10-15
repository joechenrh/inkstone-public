import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { describe, expect, it } from 'vitest'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { forget, greet, makeRoom, receive, relay, type Wire } from '../../src/server/live/protocol.js'

/**
 * The server relays a document it cannot read.
 *
 * That is the claim the whole design rests on: no ProseMirror schema in Node, no Milkdown on the
 * server, just bytes merged and handed on. So these tests put a *real* Yjs document on each end and
 * speak the real protocol over arrays — if the server needed to understand the content, the text
 * would not arrive.
 */

const SYNC = 0
const AWARENESS = 1

/** A client, as far as the wire is concerned: a Yjs document and an inbox. */
function client(room: ReturnType<typeof makeRoom>) {
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  const inbox: Uint8Array[] = []
  const wire: Wire = { send: (data) => { inbox.push(data) } }
  room.wires.add(wire)

  /** Everything the inbox holds, applied — and anything that needs an answer, answered. */
  const settle = () => {
    let changed = false
    while (inbox.length > 0) {
      const data = inbox.shift()!
      const decoder = decoding.createDecoder(data)
      const kind = decoding.readVarUint(decoder)
      if (kind === SYNC) {
        const reply = encoding.createEncoder()
        encoding.writeVarUint(reply, SYNC)
        syncProtocol.readSyncMessage(decoder, reply, doc, 'server')
        if (encoding.length(reply) > 1) changed = receive(room, wire, encoding.toUint8Array(reply)) || changed
      } else if (kind === AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), 'server')
      }
    }
    return changed
  }

  /** Type, and send what that produced the way the real provider does. */
  const type = (text: string) => {
    const before = Y.encodeStateVector(doc)
    doc.getText('note').insert(doc.getText('note').length, text)
    const message = encoding.createEncoder()
    encoding.writeVarUint(message, SYNC)
    syncProtocol.writeUpdate(message, Y.encodeStateAsUpdate(doc, before))
    return receive(room, wire, encoding.toUint8Array(message))
  }

  /**
   * What the real provider says on open: its own step one.
   *
   * The server's greeting is a question about what the *client* has; the content travels the other
   * way only once the client asks the same question back. A test that left this out had a late
   * joiner receiving an empty document, which is exactly the bug it would have shipped.
   */
  const hello = () => {
    const message = encoding.createEncoder()
    encoding.writeVarUint(message, SYNC)
    syncProtocol.writeSyncStep1(message, doc)
    receive(room, wire, encoding.toUint8Array(message))
  }

  const announce = (state: Record<string, unknown>) => {
    awareness.setLocalState(state)
    const message = encoding.createEncoder()
    encoding.writeVarUint(message, AWARENESS)
    encoding.writeVarUint8Array(
      message,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
    )
    receive(room, wire, encoding.toUint8Array(message))
  }

  return { doc, awareness, wire, inbox, settle, type, hello, announce, text: () => doc.getText('note').toString() }
}

describe('the wire', () => {
  it('carries what one person types to another, through a server that never reads it', () => {
    const room = makeRoom(new Y.Doc())
    const stop = relay(room)
    const owner = client(room)
    const guest = client(room)
    greet(room, owner.wire)
    owner.hello()
    owner.settle()
    greet(room, guest.wire)
    guest.hello()
    guest.settle()

    owner.type('周会')
    guest.settle()
    expect(guest.text()).toBe('周会')

    guest.type('，下周')
    owner.settle()
    expect(owner.text()).toBe('周会，下周')
    // And the server holds the merge of both, as bytes it did not interpret.
    expect(room.doc.getText('note').toString()).toBe('周会，下周')
    stop()
  })

  it('does not send anybody their own bytes back', () => {
    const room = makeRoom(new Y.Doc())
    const stop = relay(room)
    const owner = client(room)
    greet(room, owner.wire)
    owner.hello()
    owner.settle()

    owner.type('a')
    expect(owner.inbox).toEqual([])
    stop()
  })

  it('gives a late joiner everything said before they arrived', () => {
    const room = makeRoom(new Y.Doc())
    const stop = relay(room)
    const owner = client(room)
    greet(room, owner.wire)
    owner.hello()
    owner.settle()
    owner.type('先写的')

    const late = client(room)
    greet(room, late.wire)
    late.hello()
    late.settle()
    expect(late.text()).toBe('先写的')
    stop()
  })

  it('reports a change to the document, and silence for a moved caret', () => {
    const room = makeRoom(new Y.Doc())
    const stop = relay(room)
    const owner = client(room)
    greet(room, owner.wire)
    owner.hello()
    owner.settle()

    // The idle clock is measured off this: a room full of moving carets is an idle room.
    expect(owner.type('x')).toBe(true)
    const caret = encoding.createEncoder()
    encoding.writeVarUint(caret, AWARENESS)
    encoding.writeVarUint8Array(
      caret,
      awarenessProtocol.encodeAwarenessUpdate(owner.awareness, [owner.awareness.clientID]),
    )
    expect(receive(room, owner.wire, encoding.toUint8Array(caret))).toBe(false)
    stop()
  })

  it('carries who is here, and takes them away when their socket goes', () => {
    const room = makeRoom(new Y.Doc())
    const stop = relay(room)
    const owner = client(room)
    const guest = client(room)
    greet(room, owner.wire)
    owner.hello()
    owner.settle()
    greet(room, guest.wire)
    guest.hello()
    guest.settle()

    guest.announce({ user: { name: '访客 2', color: '#9a6b1f' } })
    owner.settle()
    const seen = [...owner.awareness.getStates().values()]
    expect(seen).toContainEqual({ user: { name: '访客 2', color: '#9a6b1f' } })

    forget(room, guest.wire, [guest.awareness.clientID])
    owner.settle()
    expect(owner.awareness.getStates().get(guest.awareness.clientID)).toBeUndefined()
    stop()
  })

  it('drops nonsense from a stranger rather than taking the room down', () => {
    const room = makeRoom(new Y.Doc())
    const stop = relay(room)
    const owner = client(room)
    greet(room, owner.wire)
    owner.hello()
    owner.settle()
    owner.type('still here')

    // Anybody with the link can reach this socket.
    expect(receive(room, owner.wire, new Uint8Array([9, 9, 9, 9]))).toBe(false)
    expect(receive(room, owner.wire, new Uint8Array([]))).toBe(false)
    expect(room.doc.getText('note').toString()).toBe('still here')
    stop()
  })
})
