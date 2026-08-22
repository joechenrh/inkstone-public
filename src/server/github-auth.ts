import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Signing in with GitHub, for the route in `docs/design/public-route.md`.
 *
 * This is everything the server does for that route, and it is deliberately small: it exchanges a
 * code for a token, renews that token, and forgets. **The notes never come near it.** The browser
 * talks to `api.github.com` itself; this file exists only because the client secret cannot.
 *
 * Where the tokens live, and why:
 *
 * - The **access token** (eight hours) is returned to the browser, which keeps it in memory. It is
 *   never written to storage, so a reload asks for a new one rather than leaving one lying about.
 * - The **refresh token** (six months) goes into an `httpOnly` cookie. Script on this origin can
 *   spend it while it is running but cannot read it, which is the difference that matters: an
 *   injected script gets the length of its own execution rather than six months of offline access.
 *   The cookie is signed, and it is the only state involved — the server keeps no session table
 *   and no per-user record.
 *
 * Nothing here runs unless `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set. The single-user
 * deployment sets neither, and is unaffected by this file's existence.
 */

export const REFRESH_COOKIE = 'inkstone_gh'
const STATE_COOKIE = 'inkstone_gh_state'
/**
 * Where to land after signing in, when it is not the app's front door.
 *
 * Sharing needs this: a reader who presses Save on `/share/k3f9x2` must come back to the note they
 * were reading rather than to an empty editor, which is a different page and has lost the thing
 * they wanted. Carried in a cookie rather than in the callback URL, which GitHub matches exactly
 * against the ones the App registered.
 */
const RETURN_COOKIE = 'inkstone_gh_return'
const AUTHORIZE = 'https://github.com/login/oauth/authorize'
const TOKEN = 'https://github.com/login/oauth/access_token'
const REFRESH_MAX_AGE = 60 * 60 * 24 * 180
const STATE_MAX_AGE = 600

export interface GitHubAuthConfig {
  clientId: string
  clientSecret: string
  /**
   * The App's public slug, as in `github.com/apps/<slug>`.
   *
   * Only used to build the link that installs it. Without it, someone who has signed in but never
   * chosen a repository has nowhere to go — and a dead end is a bug.
   */
  appSlug: string | null
}

export interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token: string
  error?: string
  error_description?: string
  /** This server could not reach github.com at all, which is not the same as being refused. */
  unreachable?: true
}

export interface GitHubAuthDeps {
  /** Injectable so tests exercise these routes without reaching github.com. */
  fetch?: typeof globalThis.fetch
  randomState?: () => string
}

export function registerGitHubAuth(
  app: FastifyInstance,
  cfg: GitHubAuthConfig | null,
  deps: GitHubAuthDeps = {},
): void {
  const doFetch = deps.fetch ?? globalThis.fetch
  const randomState = deps.randomState ?? (() => randomBytes(16).toString('hex'))

  const unavailable = (reply: FastifyReply) =>
    reply.code(503).send({ error: 'GitHub sign-in is not configured on this server' })

  async function exchange(body: Record<string, string>): Promise<TokenResponse> {
    try {
      const res = await doFetch(TOKEN, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return await res.json() as TokenResponse
    } catch {
      // Not hypothetical: `github.com` is blocked by SNI from some hosts while `api.github.com`
      // stays reachable, so this server can be unable to sign anyone in while every browser it
      // serves talks to GitHub perfectly well. Left to escape, this surfaced as a bare 500 after
      // a ten-second wait, which says nothing to the person staring at it and nothing to whoever
      // has to fix it.
      return {
        access_token: '',
        expires_in: 0,
        refresh_token: '',
        unreachable: true,
        error: 'unreachable',
        error_description: 'This server could not reach github.com. Sign-in needs an outbound route to it; the browser\'s own connection to GitHub is a separate matter and may well be fine.',
      }
    }
  }

  function keepRefresh(reply: FastifyReply, token: string): void {
    reply.setCookie(REFRESH_COOKIE, token, { ...cookieOptions(reply.request), maxAge: REFRESH_MAX_AGE })
  }

  /**
   * `Secure` everywhere except on localhost, where a browser drops a Secure cookie sent over
   * http and sign-in would fail with nothing to see. Development is the only case that is not
   * https, and it is recognisable by the host rather than by a flag someone could leave set.
   */
  function cookieOptions(req: FastifyRequest) {
    return { path: '/', httpOnly: true, sameSite: 'lax' as const, signed: true, secure: !isLocal(req) }
  }

  /** Where GitHub should come back to: this very origin, whichever one it is. */
  function callbackUrl(req: FastifyRequest): string {
    const scheme = isLocal(req) ? 'http' : 'https'
    return `${scheme}://${req.headers.host ?? ''}/api/github/callback`
  }

  /**
   * Where to send someone who has signed in but given the app no repositories.
   *
   * Public and unauthenticated: it says nothing that `github.com/apps/<slug>` does not say to
   * anyone who visits it.
   */
  app.get('/api/github/app', async (_req, reply) => {
    const slug = cfg?.appSlug ?? null
    return reply.send({
      installUrl: slug === null ? null : `https://github.com/apps/${slug}/installations/new`,
    })
  })

  /** Leaves for GitHub's own screen. The `state` and where to come back to are carried across. */
  app.get<{ Querystring: { return?: string } }>('/api/github/start', async (req, reply) => {
    if (cfg === null) return unavailable(reply)
    const state = randomState()
    const back = safeReturn(req.query.return)
    if (back !== null) {
      reply.setCookie(RETURN_COOKIE, back, { ...cookieOptions(req), maxAge: STATE_MAX_AGE })
    }
    const url = new URL(AUTHORIZE)
    url.searchParams.set('client_id', cfg.clientId)
    url.searchParams.set('state', state)
    // Explicit, because an App may have several callback URLs registered and GitHub picks the
    // first one when this is left off — which sends a developer on localhost to production.
    url.searchParams.set('redirect_uri', callbackUrl(req))

    return reply
      .setCookie(STATE_COOKIE, state, { ...cookieOptions(req), maxAge: STATE_MAX_AGE })
      .redirect(url.toString())
  })

  /**
   * Where GitHub sends the user back — after signing in, after installing, and after changing
   * which repositories are shared. One route for all three, because enabling OAuth during
   * installation makes GitHub disable the separate setup URL. That is a simplification: there is
   * no second path to keep in step.
   */
  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/api/github/callback',
    async (req, reply) => {
      if (cfg === null) return unavailable(reply)

      const expected = signedCookie(req, STATE_COOKIE)
      const { code, state } = req.query
      reply.clearCookie(STATE_COOKIE, { path: '/' })

      // A callback whose state does not match the one this browser was given is not this
      // browser's sign-in, and completing it would attach someone else's account to this session.
      if (!code || !state || expected === null || state !== expected) {
        return reply.code(400).send({ error: 'sign-in could not be verified — start again' })
      }

      const token = await exchange({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        // GitHub checks this against the one the authorize step was given.
        redirect_uri: callbackUrl(req),
      })
      if (token.error !== undefined || !token.access_token) {
        req.log.error({ err: token.error }, 'github token exchange failed')
        return reply
          .code(token.unreachable ? 503 : 502)
          .send({ error: token.error_description ?? 'GitHub refused the sign-in' })
      }

      if (token.refresh_token) keepRefresh(reply, token.refresh_token)
      const back = safeReturn(signedCookie(req, RETURN_COOKIE))
      reply.clearCookie(RETURN_COOKIE, { path: '/' })
      // Back to the app, which asks for an access token on load. The token itself never appears
      // in a URL, where it would land in history and in any log along the way.
      return reply.redirect(back ?? '/')
    },
  )

  /**
   * An access token for the browser to hold in memory.
   *
   * GitHub rotates the refresh token on every use, so the cookie is rewritten each time. A request
   * with no cookie is not an error — it is what being signed out looks like.
   */
  app.post('/api/github/token', async (req, reply) => {
    if (cfg === null) return unavailable(reply)
    const refresh = signedCookie(req, REFRESH_COOKIE)
    if (refresh === null) return reply.code(401).send({ error: 'not signed in' })

    const token = await exchange({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refresh,
    })
    if (token.unreachable) {
      // Keep the cookie: the session is fine, this server's route to GitHub is not. Clearing it
      // would sign the user out over a network fault and lose a perfectly good refresh token.
      req.log.error('github unreachable while renewing a token')
      return reply.code(503).send({ error: token.error_description })
    }
    if (token.error !== undefined || !token.access_token) {
      // The refresh token is spent or revoked; clearing it makes the next load say "signed out"
      // rather than retry something that cannot work.
      return reply
        .clearCookie(REFRESH_COOKIE, { path: '/' })
        .code(401)
        .send({ error: 'sign in again' })
    }

    if (token.refresh_token) keepRefresh(reply, token.refresh_token)
    return reply.send({ accessToken: token.access_token, expiresIn: token.expires_in })
  })

  app.post('/api/github/signout', async (_req, reply) => {
    // Only this server's copy. The installation itself is revoked on GitHub, which is the link the
    // sign-in screen gives — that is the difference between signing out and taking access away.
    return reply.clearCookie(REFRESH_COOKIE, { path: '/' }).code(204).send()
  })
}

/**
 * A path on this origin, or nothing.
 *
 * Checked here rather than trusted from the cookie: a redirect target that can be set from outside
 * is an open redirect, which is exactly the shape a phishing link wants. `//host` is rejected too —
 * it is protocol-relative, and browsers read it as another origin.
 */
function safeReturn(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null
  return raw
}

function isLocal(req: FastifyRequest): boolean {
  const host = req.headers.host ?? ''
  return host.startsWith('localhost:') || host.startsWith('127.0.0.1:')
}

function signedCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.cookies[name]
  if (!raw) return null
  const unsigned = req.unsignCookie(raw)
  return unsigned.valid && unsigned.value !== null ? unsigned.value : null
}
