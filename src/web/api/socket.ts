import type { ServerEvent } from '../../shared/events.js'

export type SocketState = 'connecting' | 'open' | 'closed' | 'unauthorized'

/** Custom close code for an invalidated session; corresponds to socket.close(4401) in ws.ts. */
const UNAUTHORIZED_CODE = 4401
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000
const JITTER = 0.2

export interface WebSocketLike {
  onopen: (() => void) | null
  onclose: ((ev: { code: number }) => void) | null
  onmessage: ((ev: { data: string }) => void) | null
  onerror: (() => void) | null
  close(): void
}

export interface SocketOptions {
  url: string
  onEvent: (event: ServerEvent) => void
  onStateChange?: (state: SocketState) => void
  onReconnect?: () => void
  factory?: (url: string) => WebSocketLike
  random?: () => number
  schedule?: (fn: () => void, ms: number) => number
}

export class EventSocket {
  #state: SocketState = 'closed'
  #socket: WebSocketLike | null = null
  #attempt = 0
  #everOpened = false
  #manualClose = false
  #retryDelayMs = 0
  /** Incremented on each close(); lets scheduled timers detect they are stale. */
  #generation = 0

  readonly #opts: Required<Pick<SocketOptions, 'factory' | 'random' | 'schedule'>> & SocketOptions

  constructor(opts: SocketOptions) {
    this.#opts = {
      ...opts,
      factory: opts.factory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike),
      random: opts.random ?? Math.random,
      schedule: opts.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number),
    }
  }

  get state(): SocketState {
    return this.#state
  }

  get retryDelayMs(): number {
    return this.#retryDelayMs
  }

  connect(): void {
    if (this.#state === 'unauthorized') return
    this.#manualClose = false
    this.#setState('connecting')

    const socket = this.#opts.factory(this.#opts.url)
    this.#socket = socket

    socket.onopen = () => {
      this.#attempt = 0
      this.#setState('open')
      if (this.#everOpened) this.#opts.onReconnect?.()
      this.#everOpened = true
    }

    socket.onmessage = (ev) => {
      try {
        this.#opts.onEvent(JSON.parse(ev.data) as ServerEvent)
      } catch {
        // Drop unparseable frames without affecting the connection
      }
    }

    socket.onerror = () => {
      // A close event is guaranteed to follow; reconnect logic lives entirely in onclose
    }

    socket.onclose = (ev) => {
      this.#socket = null
      if (ev.code === UNAUTHORIZED_CODE) {
        this.#setState('unauthorized')
        return
      }
      if (this.#manualClose) {
        this.#setState('closed')
        return
      }
      this.#setState('closed')
      this.#scheduleReconnect()
    }
  }

  close(): void {
    this.#manualClose = true
    this.#generation += 1
    this.#socket?.close()
    this.#socket = null
    this.#setState('closed')
  }

  #scheduleReconnect(): void {
    const raw = Math.min(BASE_DELAY_MS * 2 ** this.#attempt, MAX_DELAY_MS)
    const jitter = 1 + (this.#opts.random() * 2 - 1) * JITTER
    this.#retryDelayMs = Math.round(raw * jitter)
    this.#attempt += 1
    const gen = this.#generation
    this.#opts.schedule(() => {
      // If close() was called while this timer was pending, skip reconnect.
      if (this.#generation === gen) this.connect()
    }, this.#retryDelayMs)
  }

  #setState(next: SocketState): void {
    if (this.#state === next) return
    this.#state = next
    this.#opts.onStateChange?.(next)
  }
}
