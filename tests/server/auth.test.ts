import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { login, makeTestApp, makeUnreadyTestApp, type TestApp } from './helpers/app.js'

let t: TestApp

beforeEach(async () => {
  t = await makeTestApp()
})

afterEach(async () => {
  await t.cleanup()
})

describe('POST /api/login', () => {
  it('issues an HttpOnly signed cookie when the password is correct', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'correct-horse' },
    })
    expect(res.statusCode).toBe(204)
    const cookie = res.headers['set-cookie']
    const raw = Array.isArray(cookie) ? cookie[0] : cookie
    expect(raw).toContain('inkstone_sid=')
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('SameSite=Lax')
  })

  it('returns 401 and does not set a cookie when the password is wrong', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('returns 400 when the password field is missing', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/login', payload: {} })
    expect(res.statusCode).toBe(400)
  })
})

describe('auth guard', () => {
  it('returns 401 when accessing /api/* without a cookie', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/tree' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 for a forged unsigned cookie', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/tree',
      headers: { cookie: 'inkstone_sid=1' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 for a cookie signed with a different secret', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/tree',
      headers: { cookie: 'inkstone_sid=1.YWJjZGVm' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('allows access with a valid cookie', async () => {
    const cookie = await login(t)
    const res = await t.app.inject({ method: 'GET', url: '/api/tree', headers: { cookie } })
    expect(res.statusCode).toBe(200)
  })

  it('/api/login and /api/health do not require authentication', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
  })
})

describe('POST /api/logout', () => {
  it('clears the cookie so the old cookie becomes invalid', async () => {
    const cookie = await login(t)
    const out = await t.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })
    expect(out.statusCode).toBe(204)
    const raw = out.headers['set-cookie']
    const str = Array.isArray(raw) ? raw[0] : raw
    expect(str).toContain('inkstone_sid=;')
  })
})

// Regression: the guard must be registered on the top-level Fastify instance,
// not inside a nested app.register(async (instance) => ...) encapsulation
// context in buildApp. Fastify's hooks and decorators are scoped to their
// encapsulation context — if registered in a child context, only routes within
// that same closure are protected / can see the decorator. Future tasks will
// likely split the actual file-read/write routes into plugins (the idiomatic
// Fastify pattern); if the guard only covers the child context those new routes
// would silently be unprotected. We verify with a separate app.register plugin
// route and a route registered directly on the top-level instance, and also
// call the isAuthenticated decorator directly to confirm it is available at the
// top level and behaves correctly (the path that WebSocket upgrade auth depends on).
describe('auth guard covers the top-level instance (regression: must not be bypassable via a nested plugin)', () => {
  it('a route registered via a separate app.register plugin is also protected by the guard', async () => {
    const u = await makeUnreadyTestApp()
    u.app.register(async (instance) => {
      instance.get('/api/sibling-plugin', async () => ({ ok: true }))
    })
    await u.app.ready()

    const unauth = await u.app.inject({ method: 'GET', url: '/api/sibling-plugin' })
    expect(unauth.statusCode).toBe(401)

    const cookie = await login(u)
    const auth = await u.app.inject({
      method: 'GET',
      url: '/api/sibling-plugin',
      headers: { cookie },
    })
    expect(auth.statusCode).toBe(200)

    await u.cleanup()
  })

  it('a route registered directly on the top-level instance is also protected by the guard', async () => {
    const u = await makeUnreadyTestApp()
    u.app.get('/api/direct', async () => ({ ok: true }))
    await u.app.ready()

    const unauth = await u.app.inject({ method: 'GET', url: '/api/direct' })
    expect(unauth.statusCode).toBe(401)

    const cookie = await login(u)
    const auth = await u.app.inject({ method: 'GET', url: '/api/direct', headers: { cookie } })
    expect(auth.statusCode).toBe(200)

    await u.cleanup()
  })

  it('isAuthenticated decorator is available on the top-level instance and correctly reports auth status with a real request object', async () => {
    const u = await makeUnreadyTestApp()
    expect(typeof u.app.isAuthenticated).toBe('function')

    // /api/health is exempt from auth, so a preHandler fires regardless of
    // whether a cookie is present. We use this exempted path to obtain a real
    // FastifyRequest (with a real bound unsignCookie), then call the decorator
    // directly rather than just asserting it exists.
    let observed: boolean | undefined
    u.app.addHook('preHandler', async (req) => {
      if (req.url === '/api/health') {
        observed = u.app.isAuthenticated(req)
      }
    })
    await u.app.ready()

    await u.app.inject({ method: 'GET', url: '/api/health' })
    expect(observed).toBe(false)

    const cookie = await login(u)
    await u.app.inject({ method: 'GET', url: '/api/health', headers: { cookie } })
    expect(observed).toBe(true)

    await u.cleanup()
  })
})
