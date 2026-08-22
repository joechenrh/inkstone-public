import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'

/**
 * Whose GitHub token this is — the one fact that makes a public write endpoint safe to run.
 *
 * Its own module because it is the security-critical half of sharing and has nothing to do with
 * routing: an endpoint that stores arbitrary text and serves it from your own domain is a free
 * host for phishing unless every write is attributable, and this is where the attribution comes
 * from. There is no session of this server's own — the browser already holds a user-to-server
 * access token, and this asks GitHub who it belongs to.
 */

/** Long enough that a burst of shares costs one call, short enough that a revoked token stops working. */
const WHOAMI_TTL_MS = 5 * 60 * 1000
const WHOAMI_MAX_ENTRIES = 500

export interface ShareViewer {
  id: number
  login: string
}

/** Unreachable GitHub is not a rejected token, and the two need different answers. */
export class GitHubUnreachable extends Error {
  constructor() {
    super('github unreachable')
    this.name = 'GitHubUnreachable'
  }
}

export interface WhoamiDeps {
  /** Injectable so tests exercise this without reaching api.github.com. */
  fetch: typeof globalThis.fetch
  now: () => number
}

export function whoamiWith(deps: WhoamiDeps): (req: FastifyRequest) => Promise<ShareViewer | null> {
  const seen = new Map<string, { viewer: ShareViewer; at: number }>()

  /**
   * Whose token this is, according to GitHub.
   *
   * Cached by a hash of the token rather than the token itself: this map is the sort of thing that
   * ends up in a heap dump, and a hash of a bearer token is not a bearer token.
   */
  return async function whoami(req: FastifyRequest): Promise<ShareViewer | null> {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (token === '') return null

    const key = createHash('sha256').update(token).digest('hex')
    const hit = seen.get(key)
    if (hit !== undefined && deps.now() - hit.at < WHOAMI_TTL_MS) return hit.viewer

    let res: Response
    try {
      res = await deps.fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      })
    } catch {
      // Unreachable GitHub is not a rejected token, and telling the user to sign in again would
      // send them round a loop that cannot end.
      throw new GitHubUnreachable()
    }
    if (!res.ok) {
      seen.delete(key)
      return null
    }

    const user = await res.json() as { id: number; login: string }
    if (typeof user.id !== 'number' || typeof user.login !== 'string') return null

    // Oldest first, which for an insertion-ordered Map is simply the first key.
    if (seen.size >= WHOAMI_MAX_ENTRIES) seen.delete(seen.keys().next().value as string)
    seen.set(key, { viewer: { id: user.id, login: user.login }, at: deps.now() })
    return { id: user.id, login: user.login }
  }
}
