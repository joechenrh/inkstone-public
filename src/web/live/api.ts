/**
 * The four requests a live session needs.
 *
 * The same shape as `share/api.ts`, including where the credential comes from: the caller holds it
 * and passes it, because only the caller knows which deployment this is. A vault has a session
 * cookie and no token at all, and `null` is the honest spelling of that. The socket is
 * `provider.ts`.
 */

export interface LiveStarted {
  id: string
  path: string
  title: string
  /** The owner's own credential for the socket, which cannot carry a header. See `live/routes.ts`. */
  ticket: string
  /** True when this is work that outlived the owner's connection and is being handed back. */
  reclaim: boolean
}

export interface LiveMeta {
  title: string
  /** Null on a vault deployment, where there is one owner and no name for them. */
  owner: string | null
  guests: number
  full: boolean
}

/** A vault deployment has a cookie and no token; `null` must not become `Bearer null`. */
function bearer(token: string | null): Record<string, string> {
  return token === null ? {} : { authorization: `Bearer ${token}` }
}

export class LiveError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'LiveError'
    this.status = status
  }
}

async function failure(res: Response): Promise<never> {
  let message = 'This server could not start a session.'
  try {
    const body = await res.json() as { error?: string }
    if (typeof body.error === 'string' && body.error !== '') message = body.error
  } catch { /* an error page rather than JSON; the sentence above is the honest one */ }
  throw new LiveError(message, res.status)
}

/** Start one, or get back the one already running for this note. */
export async function startSession(
  token: string | null,
  path: string,
  title: string,
): Promise<LiveStarted> {
  const res = await fetch('/api/live', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(token) },
    body: JSON.stringify({ path, title }),
  })
  if (!res.ok) return await failure(res)
  return await res.json() as LiveStarted
}

/** The session this account is running, asked when the app opens. */
export async function mySession(token: string | null): Promise<LiveStarted | null> {
  try {
    const res = await fetch('/api/live/mine', { headers: bearer(token) })
    if (!res.ok) return null
    const body = await res.json() as { session: LiveStarted | null }
    return body.session
  } catch {
    // The app opening must not depend on this answering. No session is the safe reading.
    return null
  }
}

/** What a guest is told before being asked for a name. Null for every way a link can fail. */
export async function sessionMeta(id: string): Promise<LiveMeta | null> {
  try {
    const res = await fetch(`/api/live/${encodeURIComponent(id)}`)
    if (!res.ok) return null
    return await res.json() as LiveMeta
  } catch {
    return null
  }
}

/** Stop. Not an error twice. */
export async function endSession(token: string | null, id: string): Promise<void> {
  const res = await fetch(`/api/live/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    // No content-type, because there is no body: Fastify parses one for DELETE as readily as for
    // POST, and declaring JSON with nothing after it is a 400 before any route sees it. Stopping a
    // share failed on exactly this once. See the note in `share/api.ts`.
    headers: bearer(token),
  })
  if (!res.ok && res.status !== 404) await failure(res)
}
