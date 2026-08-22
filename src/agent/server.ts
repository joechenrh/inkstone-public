import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'
import type { Backend, BackendPresence } from './backend.js'
import { privateHome } from './backends/codex-home.js'
import { Sessions } from './sessions.js'

/**
 * The local half of Phase 3: a small service on loopback that the page in the browser talks to.
 *
 * See `docs/design/agent.md` for why this exists at all and for the measurements that shaped it.
 * Three of them are load-bearing here:
 *
 * - **Loopback only, never `0.0.0.0`.** The same invariant the main server has, and here it is the
 *   only thing between a laptop on a café network and a stranger's agent.
 * - **The origin is not authentication.** CORS stops a hostile page *reading* a response; it does
 *   not stop it *sending* a request. So every request carries a token and one without does nothing.
 * - **`http://` for now.** Chromium and Firefox exempt loopback from mixed-content blocking and
 *   WebKit does not, so this is a desktop-Chrome-or-Firefox feature until someone decides a
 *   permanent DNS-and-certificate dependency is worth Safari. The design record tabulates that
 *   choice; nothing here forecloses it.
 */

/** Long enough that guessing is hopeless, short enough to paste in one line. */
const TOKEN_BYTES = 18

export interface AgentOptions {
  /** The page allowed to talk to this. Exactly one, echoed back — never `*`. */
  origin: string
  /** 0 asks the OS for a free port, which is what the pairing string then carries. */
  port?: number
  token?: string
  /**
   * What this can run. A list holding one today — the plural is here because it is the wire format
   * that is expensive to change, and the binary is the half that does not update itself.
   */
  backends: Backend[]
  /** Which machine this is, for a phone that cannot infer it. Defaults to the hostname. */
  machine?: string
  /** Injectable so tests can drive the cap and the clock. */
  sessions?: Sessions
}

/** One entry as the browser sees it: what it is, whether it is there, and which version. */
export type BackendStatus = BackendPresence & { id: string }

export interface Agent {
  server: Server
  token: string
  port: number
  /** What the user pastes into Settings: everything the app needs, and nothing to discover. */
  pairing: string
  machine: string
  backends: BackendStatus[]
  sessions: Sessions
  close(): Promise<void>
}

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Constant-time, and length-safe.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the length — so the
 * comparison is done over fixed-width buffers.
 */
function sameToken(given: string, expected: string): boolean {
  const a = Buffer.alloc(64)
  const b = Buffer.alloc(64)
  a.write(given)
  b.write(expected)
  return timingSafeEqual(a, b)
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

export async function startAgent(options: AgentOptions): Promise<Agent> {
  const token = options.token ?? newToken()
  const machine = options.machine ?? hostname()
  // Detection happens once, at startup, so a prompt never waits on `which`. A backend installed
  // while this is running is not seen until it is restarted, which is the same rule as a shell.
  const backends: BackendStatus[] = await Promise.all(
    options.backends.map(async (b) => ({ id: b.id, ...(await b.detect()) })),
  )
  // `home` is what lets a dropped conversation take the backend's own record of it — the file
  // holding the note's text — with it. Constructed without it, `forgetThread` gets null and returns
  // silently, which is how the first version left two of them on disk. The import points at
  // `backends/` from above it, the same wrong direction as `RunRequest` and left for the same
  // reason: a second backend will say what the abstraction actually is.
  const sessions = options.sessions ?? new Sessions({ home: privateHome })

  const server = createServer((req, res) => {
    // Exactly the one origin, echoed. `*` would let any page read what this returns, and what it
    // returns is the contents of someone's notes.
    const cors = {
      'access-control-allow-origin': options.origin,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
      vary: 'origin',
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }

    const send = (status: number, body: unknown) => {
      res.writeHead(status, { ...cors, 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // Before routing, not per-route: a route added later must not be able to forget this.
    if (!sameToken(bearer(req), token)) {
      return send(401, { error: 'this request carried no pairing token, or the wrong one' })
    }

    const path = (req.url ?? '/').split('?')[0]

    if (req.method === 'GET' && path === '/status') {
      // `backends`, not `codex`, and plural from the first version. A browser that learned either
      // the word or the singular would have to unlearn it in public, across versions of an app that
      // updates itself and a binary that does not.
      return send(200, { agent: 'inkstone-agent', machine, backends })
    }

    // Which notes are mid-conversation, so the drawer can say so without asking note by note.
    if (req.method === 'GET' && path === '/sessions') {
      return send(200, { sessions: sessions.list() })
    }

    // What "New" does. The workspace goes and the backend's own record of the conversation goes
    // with it — see `forgetThread` in `sessions.ts` for why that second half is not optional.
    if (req.method === 'DELETE' && path === '/session') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        let parsed: { title?: unknown }
        try {
          parsed = JSON.parse(body || '{}') as typeof parsed
        } catch {
          return send(400, { error: 'that was not JSON' })
        }
        if (typeof parsed.title !== 'string') return send(400, { error: 'which note?' })
        void sessions.drop(parsed.title).then((dropped) => send(200, { dropped }))
      })
      return
    }

    if (req.method === 'POST' && path === '/run') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        let parsed: { note?: unknown; prompt?: unknown; search?: unknown; backend?: unknown; title?: unknown }
        try {
          parsed = JSON.parse(body || '{}') as typeof parsed
        } catch {
          return send(400, { error: 'that was not JSON' })
        }
        if (typeof parsed.note !== 'string' || typeof parsed.prompt !== 'string') {
          return send(400, { error: 'a run needs a note and a prompt' })
        }

        // The browser names the backend on every run and this never substitutes one for another,
        // even when there is only one to substitute. Quietly running someone's note through a model
        // they did not choose is the same failure as falling back to a server: plausible, silent,
        // and not what was asked for.
        if (typeof parsed.backend !== 'string') {
          return send(400, { error: 'a run must name the backend to run it on' })
        }
        const chosen = options.backends.find((b) => b.id === parsed.backend)
        const presence = backends.find((b) => b.id === parsed.backend)
        if (!chosen || !presence) {
          return send(404, { error: `this agent does not run '${parsed.backend}'` })
        }
        if (!presence.found) {
          return send(409, { error: `'${chosen.id}' is not installed on ${machine}` })
        }
        // The conversation for this note, opened if there is not one. The browser sends no session
        // id and holds none — it names the note it is looking at, which is the only thing it
        // reliably knows. See `sessions.ts`.
        const title = typeof parsed.title === 'string' ? parsed.title : ''

        // Newline-delimited JSON on a chunked response, rather than SSE. `EventSource` cannot
        // carry an Authorization header or a body, so this would be read with `fetch` and a stream
        // reader either way — and once you are parsing the stream yourself, SSE's framing is
        // ceremony. A run took twenty-five to thirty-five seconds in testing; nobody should watch
        // that happen behind a spinner.
        res.writeHead(200, { ...cors, 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
        res.flushHeaders()

        const line = (value: unknown) => { res.write(`${JSON.stringify(value)}\n`) }

        // The browser going away is the only signal that a run is no longer wanted: the reader
        // pressed Stop, or closed the tab. Without forwarding it, the process ran to completion
        // and spent their model quota on an answer nobody would ever see.
        const gone = new AbortController()
        res.on('close', () => { if (!res.writableEnded) gone.abort() })

        void sessions.for(title).then(async (session) => {
          const note = parsed.note as string
          const result = await chosen.run(
            {
              note,
              prompt: parsed.prompt as string,
              search: parsed.search === true,
              title: title === '' ? undefined : title,
              dir: session.dir,
              resume: session.thread,
              since: session.lastNote,
              signal: gone.signal,
            },
            line,
          )
          // Recorded only on the way out, so a turn that never reached the model cannot leave the
          // session claiming a thread that does not exist or a note the model never saw.
          if (result.ok) {
            session.thread = result.thread ?? session.thread
            session.lastNote = result.changed && result.text !== null ? result.text : note
            session.turns += 1
          }
          // `thread` is deliberately not in what the browser reads: it holds no session id.
          const { thread: _thread, ...forBrowser } = result as { thread?: unknown }
          line({ kind: 'result', ...forBrowser, turn: session.turns })
          res.end()
        }).catch((err: unknown) => {
          line({ kind: 'result', ok: false, error: err instanceof Error ? err.message : 'failed' })
          res.end()
        })
      })
      return
    }

    return send(404, { error: 'no such endpoint' })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // '127.0.0.1', never '0.0.0.0' and never omitted — omitting it listens on every interface.
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    server,
    token,
    port,
    pairing: `127.0.0.1:${port}/${token}`,
    machine,
    backends,
    sessions,
    // Nothing this held should outlive the process that held it: every workspace and every thread
    // file goes before the socket does.
    close: async () => {
      await sessions.closeAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
