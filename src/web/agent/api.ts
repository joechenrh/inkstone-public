/**
 * Talking to the agent binary on this machine.
 *
 * Two things are worth knowing before reading this.
 *
 * **The transport is loopback today and a relay tomorrow.** The binary prints
 * `127.0.0.1:<port>/<token>` and the browser fetches that directly. `docs/design/agent.md` describes
 * the account model that replaces this — the binary dials out, the server relays ciphertext — and
 * when it lands only this file changes. Everything above it asks for a status and a run.
 *
 * **`http://` from an `https://` page is a browser-by-browser question.** Chromium and Firefox
 * exempt loopback from mixed-content blocking; WebKit does not. A blocked request is
 * indistinguishable from a refused connection at the `fetch` layer — both are a bare `TypeError` —
 * so `unreachable` says both things, because the reader cannot be told which without guessing.
 */

/** What the binary can run, as the browser sees it. Never `codex`: see `src/agent/backend.ts`. */
export interface BackendStatus {
  id: string
  found: boolean
  version: string | null
  path: string | null
}

export interface AgentStatus {
  machine: string
  backends: BackendStatus[]
}

export type AgentFailure =
  /** Nothing answered. The binary is not running, or this browser blocks loopback from https. */
  | { kind: 'unreachable' }
  /** Something answered and rejected the token. The pairing string is stale — it changes per run. */
  | { kind: 'bad-token' }
  /** This agent does not have that backend at all. */
  | { kind: 'no-such-backend'; id: string }
  /** It has it, and it is not installed on that machine. */
  | { kind: 'not-installed'; detail: string }
  /** It answered and said no in its own words. Worth showing verbatim. */
  | { kind: 'refused'; detail: string }

export class AgentError extends Error {
  constructor(readonly failure: AgentFailure) {
    super(failure.kind)
    this.name = 'AgentError'
  }
}

/** What the binary streams while it works. Ours, not any backend's own event shapes. */
export type RunEvent =
  | { kind: 'said'; text: string }
  | { kind: 'ran'; command: string }
  | { kind: 'edited' }
  | { kind: 'done' }

export type RunResult =
  | { ok: true; answer: string; text: string | null; changed: boolean }
  | { ok: false; error: string }

export interface Pairing {
  host: string
  token: string
}

/**
 * `127.0.0.1:63735/CwbEbUb…` — everything the browser needs and nothing to discover.
 *
 * Deliberately strict about the host. A pairing string is pasted, and a pasted string is a place to
 * put a hostname that is not this machine; accepting one would turn a paste into "send my notes
 * there". The binary only ever listens on loopback, so only loopback is accepted.
 */
export function parsePairing(raw: string): Pairing | null {
  const trimmed = raw.trim().replace(/^https?:\/\//, '')
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\/([A-Za-z0-9_-]{16,})$/.exec(trimmed)
  if (!match) return null
  const port = Number(match[2])
  if (port < 1 || port > 65535) return null
  return { host: `${match[1]}:${port}`, token: match[3]! }
}

async function send(pairing: Pairing, path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`http://${pairing.host}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${pairing.token}`,
        // Only where there is a body, the same rule the share client learned the hard way.
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    })
  } catch {
    throw new AgentError({ kind: 'unreachable' })
  }

  if (res.ok) return res
  if (res.status === 401) throw new AgentError({ kind: 'bad-token' })

  const body = await res.json().catch(() => ({})) as { error?: string }
  const detail = body.error ?? `${res.status}`
  if (res.status === 404) throw new AgentError({ kind: 'no-such-backend', id: detail })
  if (res.status === 409) throw new AgentError({ kind: 'not-installed', detail })
  throw new AgentError({ kind: 'refused', detail })
}

/** Which notes are mid-conversation, so the drawer knows before it asks about one. */
export async function sessions(pairing: Pairing): Promise<{ key: string; turns: number }[]> {
  const res = await send(pairing, '/sessions')
  const body = await res.json() as { sessions?: { key: string; turns: number }[] }
  return body.sessions ?? []
}

/** What "New" does. The binary owns the session, so ending one is a request rather than a forget. */
export async function dropSession(pairing: Pairing, title: string): Promise<void> {
  await send(pairing, '/session', { method: 'DELETE', body: JSON.stringify({ title }) })
}

export async function status(pairing: Pairing): Promise<AgentStatus> {
  const res = await send(pairing, '/status')
  const body = await res.json() as { machine?: string; backends?: BackendStatus[] }
  // An older binary answering a newer app: it has no `machine` and no list. Reading it as "nothing
  // to run" is the honest answer — this app cannot name a backend it was not told about, and it
  // must not fall back to guessing one.
  return { machine: body.machine ?? 'this machine', backends: body.backends ?? [] }
}

/**
 * One run, streamed.
 *
 * `backend` is named on every call and never inferred, even when the status listed exactly one.
 * The binary refuses an unnamed one for the same reason: a note run through a model nobody chose is
 * the quietest way to break the promise this whole feature rests on.
 */
export async function run(
  pairing: Pairing,
  request: { backend: string; note: string; prompt: string; title: string; search: boolean },
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
): Promise<RunResult> {
  const res = await send(pairing, '/run', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  })

  const reader = res.body?.getReader()
  if (!reader) throw new AgentError({ kind: 'unreachable' })

  const decoder = new TextDecoder()
  let buffer = ''
  let result: RunResult | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Newline-delimited JSON: a chunk may hold several lines or half of one, so the tail is kept
    // until its newline arrives. Splitting on every chunk boundary would drop events at random,
    // and the ones it dropped would be the ones that arrived fastest.
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      let parsed: (RunEvent | (RunResult & { kind: 'result' }))
      try {
        parsed = JSON.parse(line) as typeof parsed
      } catch {
        continue // a half-written line the binary is still flushing
      }
      if (parsed.kind === 'result') {
        const { kind: _kind, ...rest } = parsed
        result = rest as RunResult
      } else {
        onEvent(parsed)
      }
    }
  }

  // The stream ended without a result: the binary died, or the connection dropped mid-run. That is
  // not a successful run with an empty answer, and must never be shown as one.
  return result ?? { ok: false, error: 'the agent stopped before it finished' }
}
