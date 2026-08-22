import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from './config.js'

export const SESSION_COOKIE = 'inkstone_sid'
const SESSION_VALUE = '1'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/** API paths that are exempt from authentication. Static frontend assets have their own exemption (see app.ts). */
const PUBLIC_API = new Set([
  '/api/login',
  '/api/health',
  // How to sign in cannot itself require being signed in.
  '/api/config',
  // Signing in with GitHub cannot require being signed in. These answer 503 unless the server was
  // given the App's credentials, so on the single-user deployment they are inert.
  '/api/github/app',
  '/api/github/start',
  '/api/github/callback',
  '/api/github/token',
  '/api/github/signout',
])

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function isAuthenticated(req: FastifyRequest): boolean {
  const raw = req.cookies[SESSION_COOKIE]
  if (!raw) return false
  const unsigned = req.unsignCookie(raw)
  return unsigned.valid && unsigned.value === SESSION_VALUE
}

export function registerAuth(app: FastifyInstance, cfg: Config): void {
  app.decorate('isAuthenticated', isAuthenticated)

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    // github mode has no vault and no password: there is nothing here to guard, and a blanket
    // 401 would promise that signing in gets you a vault this server does not have. Unmatched
    // routes then 404, which is the truth.
    if (cfg.vault === null) return
    const queryIndex = req.url.indexOf('?')
    const pathOnly = queryIndex === -1 ? req.url : req.url.slice(0, queryIndex)
    if (PUBLIC_API.has(pathOnly)) return
    // Sharing does its own authentication, with the GitHub token the browser already holds, and
    // reading a shared note deliberately needs none — a link that needs an account is not a link.
    // On a deployment that is both a vault and a GitHub sign-in, the vault's password is not the
    // credential any of these routes are about.
    if (pathOnly === '/api/shares' || pathOnly === '/api/share' || pathOnly.startsWith('/api/share/')) return
    if (isAuthenticated(req)) return
    return reply.code(401).send({ error: 'unauthorized' })
  })

  app.post<{ Body: { password?: unknown } }>('/api/login', async (req, reply) => {
    // github mode has no shared password, and no vault for one to protect.
    if (cfg.vault === null) {
      return reply.code(503).send({ error: 'this server has no password sign-in' })
    }
    const password = req.body?.password
    if (typeof password !== 'string' || password.length === 0) {
      return reply.code(400).send({ error: 'password is required' })
    }
    if (!constantTimeEquals(password, cfg.vault.password)) {
      return reply.code(401).send({ error: 'invalid password' })
    }
    return reply
      .setCookie(SESSION_COOKIE, SESSION_VALUE, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        signed: true,
        maxAge: MAX_AGE_SECONDS,
      })
      .code(204)
      .send()
  })

  app.post('/api/logout', async (_req, reply) => {
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send()
  })

  app.get('/api/health', async () => ({ ok: true }))

  /**
   * What kind of server this is, asked once before anything renders.
   *
   * The browser cannot know whether it is looking at a vault behind a password or at a sign-in
   * that leads to someone's own GitHub repository, and the two need different first screens.
   * `github` wins when both are configured — that is the development arrangement, and the vault
   * stays reachable behind its password for whoever wants it.
   */
  app.get('/api/config', async () => ({
    signIn: cfg.github ? 'github' : 'password',
    // Whether this server was given somewhere to keep shared notes. A Share item that leads to a
    // 404 is worse than no Share item, so the app asks before it offers one.
    sharing: cfg.share !== null,
  }))
}

declare module 'fastify' {
  interface FastifyInstance {
    isAuthenticated(req: FastifyRequest): boolean
  }
}
