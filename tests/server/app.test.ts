import { afterEach, describe, expect, it } from 'vitest'
import { login, makeUnreadyTestApp, type TestApp } from './helpers/app.js'
import { VaultError } from '../../src/server/vault/index.js'
import { VaultGitError } from '../../src/server/git/index.js'

// Task 6 Step 4b: buildApp installs a global setErrorHandler as a structural
// backstop. Fastify's default error handler echoes a thrown error's
// `.message` verbatim into the 500 body — confirmed empirically against an
// unpatched app before this handler existed:
//   GET /boom -> 500 {"statusCode":500,...,"message":"ENOENT: ... '/Users/secret/vault/private.md'"}
// These tests pin two things that must never regress:
//   1. an arbitrary unwrapped throw (e.g. a raw Node fs error) never reaches
//      the client with its message intact, even though every route today
//      wraps its own errors — this is the safety net for the routes that
//      don't.
//   2. the original error is still handed to the request logger, so the
//      scrubbing only affects the client-facing body, never operator
//      visibility.
let t: TestApp | undefined

afterEach(async () => {
  await t?.cleanup()
  t = undefined
})

describe('global error fallback: setErrorHandler', () => {
  it('unwrapped exception (containing server absolute path) is scrubbed to a generic 500, but the raw error is still passed to the request logger', async () => {
    t = await makeUnreadyTestApp()

    const loggedErrors: unknown[] = []
    t.app.addHook('onRequest', async (req) => {
      const original = req.log.error.bind(req.log)
      req.log.error = ((...args: unknown[]) => {
        loggedErrors.push(args)
        return (original as (...a: unknown[]) => unknown)(...args)
      }) as typeof req.log.error
    })

    const secretPath = "/Users/secret/vault/private.md"
    t.app.get('/api/boom', async () => {
      // Mirrors a raw Node fs errno escaping unwrapped, exactly the shape
      // that motivated this handler.
      throw new Error(`ENOENT: no such file, open '${secretPath}'`)
    })
    await t.app.ready()

    const cookie = await login(t)
    const res = await t.app.inject({ method: 'GET', url: '/api/boom', headers: { cookie } })

    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain(secretPath)
    expect(res.body).not.toContain('ENOENT')
    expect(res.json()).toEqual({ error: 'internal error' })

    // The scrubbing must be response-body-only: the raw error (with the
    // absolute path) still has to reach the logger for operators. Error
    // objects don't serialize their own properties via JSON.stringify, so
    // inspect the captured arguments directly rather than stringifying.
    expect(loggedErrors.length).toBeGreaterThan(0)
    const [logArgs] = loggedErrors as [[{ err: Error }, string]]
    expect(logArgs[0].err).toBeInstanceOf(Error)
    expect(logArgs[0].err.message).toContain(secretPath)
  })

  it('VaultError not caught by the route still produces 400 with the original message', async () => {
    t = await makeUnreadyTestApp()
    t.app.get('/api/boom-vault', async () => {
      throw new VaultError('already exists: notes/dup.md')
    })
    await t.app.ready()

    const cookie = await login(t)
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/boom-vault',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'already exists: notes/dup.md' })
  })

  it('VaultGitError not caught by the route still produces 500 with the original message', async () => {
    t = await makeUnreadyTestApp()
    t.app.get('/api/boom-git', async () => {
      throw new VaultGitError('git status failed')
    })
    await t.app.ready()

    const cookie = await login(t)
    const res = await t.app.inject({ method: 'GET', url: '/api/boom-git', headers: { cookie } })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'git status failed' })
  })

  it("Fastify's own 4xx (e.g. malformed JSON body) keeps the status code but does not echo details", async () => {
    t = await makeUnreadyTestApp()
    await t.app.ready()

    const cookie = await login(t)
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/file',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{not valid json',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'bad request' })
  })
})
