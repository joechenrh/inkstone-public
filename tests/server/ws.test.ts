import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { login, makeTestApp, type TestApp } from './helpers/app.js'

// WebSocket upgrade requests to /ws bypass the onRequest guard in auth.ts
// (which only matches the /api/ prefix); each upgrade must be authenticated
// individually inside WsHub.registerRoute by calling isAuthenticated. These
// two test cases verify that path directly — watcher.test.ts in the brief does
// not cover it at all:
//   1. An upgrade request without a cookie (or with an invalid cookie) must be
//      closed with the custom close code 4401, and that client must not receive
//      any subsequent broadcasts — otherwise an unauthenticated caller could
//      see every file change in the vault.
//   2. An upgrade request with a valid cookie must successfully keep the
//      connection open and must receive events sent via hub.broadcast,
//      serialised and delivered as-is.
//
// Uses real TCP connections rather than Fastify's injectWS test helper: in
// practice injectWS constructs a handcrafted fake request object (not a real
// http.IncomingMessage) and emits 'upgrade' directly; on this code path
// @fastify/websocket@11.3.0 passes a Reply — not a FastifyRequest — as the
// second argument to the business handler (`.cookies` is undefined), causing
// auth to throw unconditionally. This is a limitation of the test helper at
// this particular library-version combination and does not reflect what happens
// with a real browser connection. Using app.listen() + a real 'ws' client
// verifies the path browsers actually follow.

async function listen(t: TestApp): Promise<number> {
  await t.app.listen({ port: 0, host: '127.0.0.1' })
  const addr = t.app.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('expected an AddressInfo')
  return addr.port
}

function once<T extends unknown[]>(
  target: { once: (event: string, cb: (...args: T) => void) => void },
  event: string,
): Promise<T> {
  return new Promise((resolve) => {
    target.once(event, (...args: T) => resolve(args))
  })
}

let t: TestApp | undefined
let sockets: WebSocket[] = []

afterEach(async () => {
  for (const ws of sockets) ws.close()
  sockets = []
  await t?.cleanup()
  t = undefined
})

describe('WebSocket /ws auth', () => {
  it('unauthenticated upgrade request is closed with 4401 and receives no broadcasts', async () => {
    t = await makeTestApp()
    const port = await listen(t)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    sockets.push(ws)
    // The handshake succeeds at the protocol level (server-side application auth
    // happens inside the handler; close occurs after open), so we wait for the
    // close event, not a rejected open.
    const [code, reason] = await once<[number, Buffer]>(ws, 'close')

    expect(code).toBe(4401)
    expect(reason.toString()).toBe('unauthorized')
    // A connection that did not pass auth must not be counted in the hub's client set.
    expect(t.hub.clientCount).toBe(0)

    // Even if a real file-change broadcast is sent afterwards, this closed
    // connection — which is not in the hub's client set — must not receive
    // anything. We assert via clientCount still being 0 rather than waiting
    // for a 'message' event that would never arrive.
    t.hub.broadcast({ type: 'tree-changed' })
    expect(t.hub.clientCount).toBe(0)
  })

  it('authenticated upgrade request keeps the connection and receives hub broadcast events', async () => {
    t = await makeTestApp()
    const cookie = await login(t)
    const port = await listen(t)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } })
    sockets.push(ws)
    await once(ws, 'open')
    expect(t.hub.clientCount).toBe(1)

    const messagePromise = once<[Buffer]>(ws, 'message')
    t.hub.broadcast({ type: 'file-changed', path: 'notes/a.md', mtimeMs: 123 })

    const [raw] = await messagePromise
    expect(JSON.parse(raw.toString())).toEqual({
      type: 'file-changed',
      path: 'notes/a.md',
      mtimeMs: 123,
    })
  })
})
