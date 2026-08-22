/**
 * The four calls sharing makes, and the failures they can produce.
 *
 * Every failure here is a sentence somewhere on screen, so they are named for what a person can do
 * about them rather than for the status code that caused them: a note that is too big is a
 * different problem from a server that is not answering, and neither is "an error occurred".
 */

export interface ShareRecord {
  id: string
  repo: string
  path: string
  expiresAt: number
}

export type ShareFailure =
  /** Over the cap. The note is untouched and retrying cannot help. */
  | { kind: 'too-large'; maxBytes: number }
  /** This account already has as many shares as it may. */
  | { kind: 'too-many'; limit: number }
  /** The token is spent or revoked; the app's own signed-out handling takes it from here. */
  | { kind: 'signed-out' }
  /** The server answered, and said no in its own words. Worth showing verbatim. */
  | { kind: 'refused'; detail: string }
  /** Nothing was reached. The note is untouched, and trying again is reasonable. */
  | { kind: 'offline' }

export class ShareError extends Error {
  constructor(readonly failure: ShareFailure) {
    super(failure.kind)
    this.name = 'ShareError'
  }
}

/** What a reader gets, or why they get nothing. */
export type SharedNote =
  | {
      ok: true
      title: string
      path: string
      content: string
      sharedAt: number
      expiresAt: number
      /** This note has a CJK face cut to its own characters. See `src/server/share/font.ts`. */
      hasFont?: boolean
    }
  | { ok: false; reason: 'missing' | 'expired' | 'stopped' | 'offline' }

export async function createShare(
  token: string,
  note: {
    repo: string
    path: string
    title: string
    content: string
    /** The pictures the note refers to, base64, copied with it. See `share/assets.ts`. */
    assets?: { name: string; bytes: string }[]
  },
): Promise<ShareRecord> {
  return send<ShareRecord>(token, '/api/share', { method: 'POST', body: JSON.stringify(note) })
}

export async function listShares(token: string): Promise<ShareRecord[]> {
  return (await send<{ shares: ShareRecord[] }>(token, '/api/shares', { method: 'GET' })).shares
}

export async function stopShare(token: string, id: string): Promise<void> {
  await send<null>(token, `/api/share/${id}`, { method: 'DELETE' })
}

/**
 * A shared note, for a reader who may have no account at all.
 *
 * The only call in this file that sends no token, which is the point of a link.
 */
export async function readShare(id: string): Promise<SharedNote> {
  let res: Response
  try {
    res = await fetch(`/api/share/${encodeURIComponent(id)}`)
  } catch {
    return { ok: false, reason: 'offline' }
  }

  if (res.ok) {
    const body = await res.json() as Omit<SharedNote & { ok: true }, 'ok'>
    return { ok: true, ...body }
  }

  const reason = await reasonOf(res)
  return { ok: false, reason: reason === null ? 'missing' : reason }
}

async function reasonOf(res: Response): Promise<'missing' | 'expired' | 'stopped' | null> {
  try {
    const body = await res.json() as { reason?: string }
    return body.reason === 'expired' || body.reason === 'stopped' || body.reason === 'missing'
      ? body.reason
      : null
  } catch {
    return null
  }
}

async function send<T>(token: string, url: string, init: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        // Only where there is a body. A DELETE carries none, and Fastify parses one for DELETE
        // as readily as for POST: declaring JSON and sending nothing is FST_ERR_CTP_EMPTY_JSON_BODY,
        // a 400 that the server's own scrubbing turns into a flat "bad request". Stop sharing
        // failed on exactly this, and `app.inject` never reproduced it because it sets no
        // content-type of its own.
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    })
  } catch {
    throw new ShareError({ kind: 'offline' })
  }

  if (res.status === 204) return null as T
  if (res.ok) return await res.json() as T

  const body = await res.json().catch(() => ({})) as {
    error?: string
    kind?: string
    maxBytes?: number
    limit?: number
  }

  if (res.status === 401) throw new ShareError({ kind: 'signed-out' })
  if (body.kind === 'too-large') {
    throw new ShareError({ kind: 'too-large', maxBytes: body.maxBytes ?? 64 * 1024 })
  }
  if (body.kind === 'too-many') throw new ShareError({ kind: 'too-many', limit: body.limit ?? 20 })
  // 503 is this server failing to reach GitHub, which from here is the same fact as not reaching
  // this server: nothing was shared, and trying again is the reasonable move.
  if (res.status >= 500) throw new ShareError({ kind: 'offline' })
  throw new ShareError({ kind: 'refused', detail: body.error ?? `${res.status}` })
}
