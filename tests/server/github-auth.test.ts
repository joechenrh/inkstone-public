import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerGitHubAuth } from '../../src/server/github-auth.js'

const CREDENTIALS = { clientId: 'Iv23-test', clientSecret: 'shhh', appSlug: 'inkstone-test' }

let app: FastifyInstance
let github: ReturnType<typeof fakeOAuth>

/** github.com's OAuth endpoint, which is a different host from the API and answers differently. */
function fakeOAuth(replies: Record<string, unknown>[]) {
  const calls: { url: string; body: Record<string, string> }[] = []
  let n = 0
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(init!.body as string) })
    const body = replies[Math.min(n++, replies.length - 1)] ?? {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

function build(
  cfg: { clientId: string; clientSecret: string; appSlug: string | null } | null,
  replies: Record<string, unknown>[] = [],
) {
  github = fakeOAuth(replies)
  const instance = Fastify()
  instance.register(cookie, { secret: 'test-signing-secret' })
  registerGitHubAuth(instance, cfg, { fetch: github.fetch, randomState: () => 'fixed-state' })
  return instance
}

/** The Set-Cookie value a browser would send back, name=value only. */
function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const all = Array.isArray(raw) ? raw : [raw]
  return all
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.split(';')[0]!)
    .join('; ')
}

beforeEach(() => { app = build(CREDENTIALS) })
afterEach(async () => { await app.close() })

describe('when the server was never given the App credentials', () => {
  it('says sign-in is not configured, rather than half-working', async () => {
    const bare = build(null)
    for (const url of ['/api/github/start', '/api/github/callback', '/api/github/token']) {
      const res = await bare.inject({ method: url.endsWith('token') ? 'POST' : 'GET', url })
      expect(res.statusCode).toBe(503)
    }
    await bare.close()
  })
})

describe('starting', () => {
  it('sends the user to GitHub with the client id and a state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/github/start' })
    expect(res.statusCode).toBe(302)
    const target = new URL(res.headers.location as string)
    expect(target.origin + target.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(target.searchParams.get('client_id')).toBe('Iv23-test')
    expect(target.searchParams.get('state')).toBe('fixed-state')
    // The secret is not in the URL the browser is about to follow, and never can be.
    expect(res.headers.location).not.toContain('shhh')
  })

  it('names the callback, so a second registered URL cannot capture the trip', async () => {
    const local = await app.inject({
      method: 'GET', url: '/api/github/start', headers: { host: 'localhost:5173' },
    })
    expect(new URL(local.headers.location as string).searchParams.get('redirect_uri'))
      .toBe('http://localhost:5173/api/github/callback')

    const remote = await app.inject({
      method: 'GET', url: '/api/github/start', headers: { host: 'notes.example.com' },
    })
    expect(new URL(remote.headers.location as string).searchParams.get('redirect_uri'))
      .toBe('https://notes.example.com/api/github/callback')
  })

  it('remembers the state where script cannot read it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/github/start' })
    const setCookie = String(res.headers['set-cookie'])
    expect(setCookie).toContain('inkstone_gh_state=')
    expect(setCookie).toContain('HttpOnly')
  })
})

describe('coming back', () => {
  async function signIn(instance: FastifyInstance) {
    const started = await instance.inject({ method: 'GET', url: '/api/github/start' })
    return instance.inject({
      method: 'GET',
      url: '/api/github/callback?code=the-code&state=fixed-state',
      headers: { cookie: cookiesFrom(started) },
    })
  }

  it('exchanges the code and lands back in the app', async () => {
    app = build(CREDENTIALS, [{ access_token: 'gho_access', expires_in: 28800, refresh_token: 'ghr_refresh' }])
    const res = await signIn(app)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
    expect(github.calls[0]!.body).toMatchObject({
      client_id: 'Iv23-test',
      client_secret: 'shhh',
      code: 'the-code',
      // GitHub checks this against the one the authorize step carried.
      redirect_uri: expect.stringContaining('/api/github/callback'),
    })
  })

  it('keeps the refresh token out of reach of script, and the access token out of the URL', async () => {
    app = build(CREDENTIALS, [{ access_token: 'gho_access', expires_in: 28800, refresh_token: 'ghr_refresh' }])
    const res = await signIn(app)
    const setCookie = String(res.headers['set-cookie'])
    expect(setCookie).toContain('inkstone_gh=')
    expect(setCookie).toContain('HttpOnly')
    // A token in a redirect URL lands in history and in every log on the way.
    expect(res.headers.location).not.toContain('gho_access')
  })

  it('refuses a callback whose state is not the one this browser was given', async () => {
    const started = await app.inject({ method: 'GET', url: '/api/github/start' })
    const res = await app.inject({
      method: 'GET',
      url: '/api/github/callback?code=the-code&state=someone-elses',
      headers: { cookie: cookiesFrom(started) },
    })
    expect(res.statusCode).toBe(400)
    expect(github.calls).toHaveLength(0)
  })

  it('refuses a callback with no state at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/github/callback?code=the-code' })
    expect(res.statusCode).toBe(400)
    expect(github.calls).toHaveLength(0)
  })

  it('passes GitHub\'s own refusal on rather than pretending it signed in', async () => {
    app = build(CREDENTIALS, [{ error: 'bad_verification_code', error_description: 'The code expired' }])
    const res = await signIn(app)
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toBe('The code expired')
  })
})

describe('when this server cannot reach github.com', () => {
  /** A host where `github.com` is blocked by SNI while `api.github.com` stays reachable. */
  function unreachable(cfg: typeof CREDENTIALS) {
    const instance = Fastify()
    instance.register(cookie, { secret: 'test-signing-secret' })
    registerGitHubAuth(instance, cfg, {
      fetch: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof globalThis.fetch,
      randomState: () => 'fixed-state',
    })
    return instance
  }

  it('says so, instead of a bare 500 ten seconds later', async () => {
    const app2 = unreachable(CREDENTIALS)
    const started = await app2.inject({ method: 'GET', url: '/api/github/start' })
    const res = await app2.inject({
      method: 'GET',
      url: '/api/github/callback?code=c&state=fixed-state',
      headers: { cookie: cookiesFrom(started) },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toMatch(/could not reach github\.com/i)
    await app2.close()
  })

  it('keeps the refresh cookie, because the session is fine and the route is not', async () => {
    // Clearing it would sign someone out over a network fault, and throw away a good token.
    const app2 = unreachable(CREDENTIALS)
    await app2.ready()
    // A cookie this server would accept, so the request reaches the exchange rather than being
    // turned away as unsigned.
    const signed = app2.signCookie('a-real-refresh-token')
    const res = await app2.inject({
      method: 'POST',
      url: '/api/github/token',
      headers: { cookie: `inkstone_gh=${signed}` },
    })
    expect(res.statusCode).not.toBe(401)
    expect(String(res.headers['set-cookie'] ?? '')).not.toContain('inkstone_gh=;')
    await app2.close()
  })
})

describe('renewing', () => {
  it('is what being signed out looks like, when there is no cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/github/token' })
    expect(res.statusCode).toBe(401)
    expect(github.calls).toHaveLength(0)
  })

  it('hands the browser an access token and rotates the refresh cookie', async () => {
    app = build(CREDENTIALS, [
      { access_token: 'first', expires_in: 28800, refresh_token: 'ghr_one' },
      { access_token: 'second', expires_in: 28800, refresh_token: 'ghr_two' },
    ])
    const started = await app.inject({ method: 'GET', url: '/api/github/start' })
    const back = await app.inject({
      method: 'GET',
      url: '/api/github/callback?code=c&state=fixed-state',
      headers: { cookie: cookiesFrom(started) },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/token',
      headers: { cookie: cookiesFrom(back) },
    })
    expect(res.json()).toEqual({ accessToken: 'second', expiresIn: 28800 })
    // GitHub rotates the refresh token on every use, so a cookie that was not rewritten would
    // work exactly once.
    expect(String(res.headers['set-cookie'])).toContain('inkstone_gh=')
    expect(github.calls[1]!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ghr_one' })
  })

  it('clears a spent refresh token instead of retrying it forever', async () => {
    app = build(CREDENTIALS, [
      { access_token: 'first', expires_in: 28800, refresh_token: 'ghr_one' },
      { error: 'bad_refresh_token' },
    ])
    const started = await app.inject({ method: 'GET', url: '/api/github/start' })
    const back = await app.inject({
      method: 'GET',
      url: '/api/github/callback?code=c&state=fixed-state',
      headers: { cookie: cookiesFrom(started) },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/github/token',
      headers: { cookie: cookiesFrom(back) },
    })
    expect(res.statusCode).toBe(401)
    expect(String(res.headers['set-cookie'])).toMatch(/inkstone_gh=;|inkstone_gh=$/)
  })

  it('will not take a refresh cookie this server did not sign', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/github/token',
      headers: { cookie: 'inkstone_gh=forged-value' },
    })
    expect(res.statusCode).toBe(401)
    expect(github.calls).toHaveLength(0)
  })
})

describe('the install link', () => {
  it('names the App, so someone with no repositories has somewhere to go', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/github/app' })
    expect(res.json()).toEqual({
      installUrl: 'https://github.com/apps/inkstone-test/installations/new',
    })
  })

  it('is null rather than a guess when the slug was not configured', async () => {
    const noSlug = build({ ...CREDENTIALS, appSlug: null })
    const res = await noSlug.inject({ method: 'GET', url: '/api/github/app' })
    expect(res.json()).toEqual({ installUrl: null })
    await noSlug.close()
  })
})

describe('signing out', () => {
  it('drops this server\'s copy and says nothing else', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/github/signout' })
    expect(res.statusCode).toBe(204)
    expect(String(res.headers['set-cookie'])).toContain('inkstone_gh=')
  })
})

describe('cookies over http', () => {
  it('are Secure in production and not on localhost, where a browser would drop them', async () => {
    const remote = await app.inject({
      method: 'GET',
      url: '/api/github/start',
      headers: { host: 'notes.example.com' },
    })
    expect(String(remote.headers['set-cookie'])).toContain('Secure')

    const local = await app.inject({
      method: 'GET',
      url: '/api/github/start',
      headers: { host: 'localhost:5173' },
    })
    expect(String(local.headers['set-cookie'])).not.toContain('Secure')
  })
})
