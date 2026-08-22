import { describe, expect, it, vi } from 'vitest'
import { EventSocket, type SocketState } from '../../../src/web/api/socket.js'
import type { ServerEvent } from '../../../src/shared/events.js'

class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: (() => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  close() {
    this.closed = true
  }

  emitOpen() {
    this.onopen?.()
  }

  emitClose(code = 1006) {
    this.onclose?.({ code })
  }

  emitMessage(event: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

interface Harness {
  socket: EventSocket
  events: ServerEvent[]
  states: SocketState[]
  timers: Array<{ fn: () => void; ms: number }>
  runTimers: () => void
  reconnects: number
}

function makeHarness(): Harness {
  FakeSocket.instances = []
  const events: ServerEvent[] = []
  const states: SocketState[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  let reconnects = 0

  const socket = new EventSocket({
    url: '/ws',
    onEvent: (e) => events.push(e),
    onStateChange: (s) => states.push(s),
    onReconnect: () => {
      reconnects += 1
    },
    factory: (url) => new FakeSocket(url) as never,
    schedule: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
  })

  return {
    socket,
    events,
    states,
    timers,
    runTimers: () => {
      const pending = timers.splice(0, timers.length)
      for (const t of pending) t.fn()
    },
    get reconnects() {
      return reconnects
    },
  } as Harness
}

describe('EventSocket normal flow', () => {
  it('state is connecting after connect, open after open', () => {
    const h = makeHarness()
    h.socket.connect()
    expect(h.socket.state).toBe('connecting')
    FakeSocket.instances[0]!.emitOpen()
    expect(h.socket.state).toBe('open')
  })

  it('forwards parsed events', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    FakeSocket.instances[0]!.emitMessage({ type: 'tree-changed' })
    expect(h.events).toEqual([{ type: 'tree-changed' }])
  })

  it('drops unparseable messages without crashing', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    FakeSocket.instances[0]!.onmessage?.({ data: 'not json' })
    expect(h.events).toHaveLength(0)
    expect(h.socket.state).toBe('open')
  })
})

describe('EventSocket reconnect', () => {
  it('reconnects with exponential backoff after disconnect', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()

    FakeSocket.instances[0]!.emitClose(1006)
    expect(h.timers[0]!.ms).toBeGreaterThanOrEqual(800)
    expect(h.timers[0]!.ms).toBeLessThanOrEqual(1200)

    h.runTimers()
    FakeSocket.instances[1]!.emitClose(1006)
    expect(h.timers[0]!.ms).toBeGreaterThanOrEqual(1600)
    expect(h.timers[0]!.ms).toBeLessThanOrEqual(2400)
  })

  it('caps the backoff at 30s', () => {
    const h = makeHarness()
    h.socket.connect()
    for (let i = 0; i < 10; i += 1) {
      FakeSocket.instances.at(-1)!.emitClose(1006)
      h.runTimers()
    }
    FakeSocket.instances.at(-1)!.emitClose(1006)
    expect(h.timers[0]!.ms).toBeLessThanOrEqual(36_000)
  })

  it('resets the backoff and triggers onReconnect after a successful reconnect', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    FakeSocket.instances[0]!.emitClose(1006)
    h.runTimers()
    FakeSocket.instances[1]!.emitOpen()

    expect(h.reconnects).toBe(1)
    FakeSocket.instances[1]!.emitClose(1006)
    expect(h.timers[0]!.ms).toBeLessThanOrEqual(1200)
  })

  it('the first open does not trigger onReconnect', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    expect(h.reconnects).toBe(0)
  })
})

describe('EventSocket auth invalidation', () => {
  it('stops reconnecting and enters unauthorized after receiving 4401', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    FakeSocket.instances[0]!.emitClose(4401)
    expect(h.socket.state).toBe('unauthorized')
    expect(h.timers).toHaveLength(0)
  })
})

describe('EventSocket.close', () => {
  it('does not reconnect after an explicit close', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    h.socket.close()
    FakeSocket.instances[0]!.emitClose(1000)
    expect(h.timers).toHaveLength(0)
    expect(h.socket.state).toBe('closed')
  })
})
