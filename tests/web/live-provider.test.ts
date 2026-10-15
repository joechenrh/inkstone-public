import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { greet, makeRoom, receive, relay, type Wire } from '../../src/server/live/protocol.js'
import { connectLive } from '../../src/web/live/provider.js'

/**
 * Both ends of the wire, against each other, with no network in between.
 *
 * The browser's provider and the server's protocol are the same wire read from either side, and the
 * bug this kind of test catches is the one that cost an afternoon of the design: a client that does
 * not send its own sync step one connects, reports itself live, and shows an empty note. Nothing
 * short of running the two halves together says so.
 *
 * The fake socket is deliberately thin — a message in one side comes out the other, synchronously.
 */

const CLOSE = { ended: 4000, gone: 4404, full: 4409, held: 4423 }

/** A server with one room in it, and sockets that reach it directly. */
function server() {
  const room = makeRoom(new Y.Doc())
  const stopRelay = relay(room)

  class FakeSocket {
    static readonly OPEN = 1
    readyState = 1
    binaryType = 'arraybuffer'
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    readonly wire: Wire
    /** Set when the server decides this socket may not be here. */
    refuseWith: number | null = null

    constructor() {
      this.wire = {
        send: (data) => {
          // A copy, because the encoder's buffer is reused and a test that kept the view would
          // read whatever was written next.
          const bytes = new Uint8Array(data)
          this.onmessage?.(new MessageEvent('message', { data: bytes.buffer }))
        },
      }
      // The handlers are attached after the constructor returns, as they are for a real socket.
      queueMicrotask(() => {
        if (this.refuseWith !== null) {
          this.readyState = 3
          this.onclose?.(new CloseEvent('close', { code: this.refuseWith }))
          return
        }
        room.wires.add(this.wire)
        this.onopen?.()
        greet(room, this.wire)
      })
    }

    send(data: Uint8Array) {
      receive(room, this.wire, new Uint8Array(data))
    }

    close(code = 1000) {
      this.readyState = 3
      room.wires.delete(this.wire)
      this.onclose?.(new CloseEvent('close', { code }))
    }
  }

  return { room, stopRelay, FakeSocket }
}

const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

describe('the browser end of a live session', () => {
  it('reports live and receives what the room already held', async () => {
    const { room, stopRelay, FakeSocket } = server()
    room.doc.getText('note').insert(0, '先写的')

    const wire = connectLive({
      id: 'k7m2qp',
      user: { name: '访客 2', color: '#9a6b1f' },
      socketFor: () => new FakeSocket() as unknown as WebSocket,
    })
    expect(wire.status.value).toBe('connecting')
    await settle()

    expect(wire.status.value).toBe('live')
    // The claim: a joiner sees what was typed before they arrived.
    expect(wire.doc.getText('note').toString()).toBe('先写的')
    wire.destroy()
    stopRelay()
  })

  it('sends what is typed in the browser to the room', async () => {
    const { room, stopRelay, FakeSocket } = server()
    const wire = connectLive({
      id: 'k7m2qp',
      user: { name: '访客 2', color: '#9a6b1f' },
      socketFor: () => new FakeSocket() as unknown as WebSocket,
    })
    await settle()

    wire.doc.getText('note').insert(0, '我写的')
    expect(room.doc.getText('note').toString()).toBe('我写的')
    wire.destroy()
    stopRelay()
  })

  it('carries a name and a colour, and lists everybody who has one', async () => {
    const { room, stopRelay, FakeSocket } = server()
    const mine = connectLive({
      id: 'k7m2qp',
      user: { name: '小林', color: '#2f7d5d' },
      socketFor: () => new FakeSocket() as unknown as WebSocket,
    })
    await settle()
    const theirs = connectLive({
      id: 'k7m2qp',
      user: { name: 'octocat', color: '#4183c4' },
      socketFor: () => new FakeSocket() as unknown as WebSocket,
    })
    await settle()

    expect(mine.peers.value).toEqual(expect.arrayContaining([
      { name: '小林', color: '#2f7d5d' },
      { name: 'octocat', color: '#4183c4' },
    ]))

    // And takes them away when they go, rather than leaving a caret on screen forever.
    theirs.destroy()
    await settle()
    expect(mine.peers.value).toEqual([{ name: '小林', color: '#2f7d5d' }])
    mine.destroy()
    stopRelay()
  })

  it('turns each way the server can close a socket into the sentence for it', async () => {
    for (const [code, said] of [
      [CLOSE.gone, 'gone'],
      [CLOSE.full, 'full'],
      [CLOSE.held, 'held'],
      [CLOSE.ended, 'ended'],
    ] as const) {
      const { stopRelay, FakeSocket } = server()
      const made = new FakeSocket()
      made.refuseWith = code
      const wire = connectLive({
        id: 'k7m2qp',
        user: { name: '访客 2', color: '#9a6b1f' },
        socketFor: () => made as unknown as WebSocket,
      })
      await settle()
      expect(wire.status.value, `close ${code}`).toBe(said)
      wire.destroy()
      stopRelay()
    }
  })

  it('retries a connection that merely broke, which is what the grace period is for', async () => {
    vi.useFakeTimers()
    try {
      const { stopRelay, FakeSocket } = server()
      const made: InstanceType<typeof FakeSocket>[] = []
      const wire = connectLive({
        id: 'k7m2qp',
        user: { name: 'octocat', color: '#4183c4' },
        ticket: 'a-ticket',
        retryMs: 10,
        socketFor: () => {
          const one = new FakeSocket()
          made.push(one)
          return one as unknown as WebSocket
        },
      })
      await vi.advanceTimersByTimeAsync(1)
      expect(wire.status.value).toBe('live')

      // The tunnel, the lid, the backgrounded phone: a close with no reason in it.
      made[0]!.close(1006)
      expect(wire.status.value).toBe('retrying')

      await vi.advanceTimersByTimeAsync(50)
      expect(made).toHaveLength(2)
      expect(wire.status.value).toBe('live')
      wire.destroy()
      stopRelay()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying once it is destroyed', async () => {
    vi.useFakeTimers()
    try {
      const { stopRelay, FakeSocket } = server()
      const made: InstanceType<typeof FakeSocket>[] = []
      const wire = connectLive({
        id: 'k7m2qp',
        user: { name: 'octocat', color: '#4183c4' },
        retryMs: 10,
        socketFor: () => {
          const one = new FakeSocket()
          made.push(one)
          return one as unknown as WebSocket
        },
      })
      await vi.advanceTimersByTimeAsync(1)
      wire.destroy()
      await vi.advanceTimersByTimeAsync(500)
      expect(made).toHaveLength(1)
      stopRelay()
    } finally {
      vi.useRealTimers()
    }
  })
})
