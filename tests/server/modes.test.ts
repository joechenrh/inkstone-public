import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { registerAuth } from '../../src/server/auth.js'
import type { Config } from '../../src/server/config.js'

const GITHUB = { clientId: 'Iv23', clientSecret: 'shhh', appSlug: 'inkstone-notes' }

function config(over: Partial<Config> = {}): Config {
  return {
    vault: null,
    github: null,
    share: null,
    sessionSecret: 'signing-secret',
    listenAddr: '127.0.0.1',
    port: 0,
    ...over,
  }
}

/** registerAuth alone, which is where `/api/config` lives. */
function authOnly(cfg: Config) {
  const app = Fastify()
  app.register(cookie, { secret: cfg.sessionSecret })
  registerAuth(app, cfg)
  return app
}

describe('/api/config', () => {
  it('says github when the App is configured', async () => {
    const app = authOnly(config({ github: GITHUB }))
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.json()).toEqual({ signIn: 'github', sharing: false })
    await app.close()
  })

  it('says password when only a vault is configured', async () => {
    const app = authOnly(config({ vault: { root: '/tmp/v', password: 'pw' } }))
    expect((await app.inject({ method: 'GET', url: '/api/config' })).json())
      .toEqual({ signIn: 'password', sharing: false })
    await app.close()
  })

  it('prefers github when both are, which is the development arrangement', async () => {
    const app = authOnly(config({ github: GITHUB, vault: { root: '/tmp/v', password: 'pw' } }))
    expect((await app.inject({ method: 'GET', url: '/api/config' })).json())
      .toEqual({ signIn: 'github', sharing: false })
    await app.close()
  })

  it('answers without a session, since it is what tells you how to get one', async () => {
    const app = authOnly(config({ vault: { root: '/tmp/v', password: 'pw' } }))
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe('a server with no vault', () => {
  it('starts, and serves none of the vault routes', async () => {
    // github mode: no directory on this machine, so no route that would read one.
    const { instance } = buildApp({ config: config({ github: GITHUB }) })
    for (const url of ['/api/tree', '/api/file?path=a.md', '/api/git/status', '/api/vault/info']) {
      const res = await instance.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(404)
    }
    await instance.close()
  })

  it('has nothing to watch and nothing to commit', () => {
    const app = buildApp({ config: config({ github: GITHUB }) })
    expect(app.watcher).toBeNull()
    expect(app.autoCommit).toBeNull()
  })

  it('refuses a password sign-in rather than checking against nothing', async () => {
    const app = authOnly(config({ github: GITHUB }))
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'x' } })
    expect(res.statusCode).toBe(503)
    await app.close()
  })
})
