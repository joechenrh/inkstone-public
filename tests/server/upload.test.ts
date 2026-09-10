import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { registerUploadRoutes } from '../../src/server/routes/upload.js'
import type { UploadConfig } from '../../src/server/config.js'
import { UploadFailed } from '../../src/uploader/index.js'

const CONFIG: UploadConfig = {
  driver: 'qiniu',
  qiniu: { accessKey: 'AK', secretKey: 'SK', bucket: 'notes', baseUrl: 'https://cdn.example.com' },
  owner: 'octocat',
}

const PICTURE = Buffer.from([137, 80, 78, 71]).toString('base64')

/** An app with the route on it, and nothing real behind it. */
function appWith(over: {
  config?: Partial<UploadConfig>
  put?: (bytes: Uint8Array, ext: string, hash: string) => Promise<string>
  signedIn?: boolean
  githubUser?: { status: number; login?: string }
} = {}): FastifyInstance {
  const app = Fastify()
  app.decorate('isAuthenticated', () => over.signedIn === true)
  registerUploadRoutes(app, {
    config: { ...CONFIG, ...over.config },
    makeUploader: () => ({
      name: 'fake',
      put: over.put ?? (async (_b, ext, hash) => `https://cdn.example.com/assets/${hash}.${ext}`),
    }),
    fetch: (async () => {
      const who = over.githubUser ?? { status: 401 }
      return new Response(JSON.stringify({ login: who.login }), { status: who.status })
    }) as unknown as typeof globalThis.fetch,
  })
  return app
}

const upload = (app: FastifyInstance, headers: Record<string, string> = {}) => app.inject({
  method: 'POST',
  url: '/api/upload',
  headers,
  payload: { bytes: PICTURE, ext: 'webp', hash: 'a1b2c3d4' },
})

/*
 * The one part of this feature with a consequence if it is wrong.
 *
 * An upload route that does not ask who is calling is an image host open to the whole internet, on
 * somebody's storage bill. The blanket rule in `auth.ts` cannot do the asking here: the GitHub route
 * has no session cookie, so a rule that demanded one would shut out the people this is for.
 */
describe('who may spend the account', () => {
  it('lets the vault session through', async () => {
    const app = appWith({ signedIn: true })
    const res = await upload(app)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ url: 'https://cdn.example.com/assets/a1b2c3d4.webp' })
    await app.close()
  })

  it('lets the owner through on a GitHub token', async () => {
    const app = appWith({ githubUser: { status: 200, login: 'octocat' } })
    expect((await upload(app, { authorization: 'Bearer gho_x' })).statusCode).toBe(200)
    await app.close()
  })

  it('refuses another GitHub account holding a perfectly good token', async () => {
    const app = appWith({ githubUser: { status: 200, login: 'someone-else' } })
    const res = await upload(app, { authorization: 'Bearer gho_x' })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('not this account')
    await app.close()
  })

  it('refuses when there are no credentials at all', async () => {
    const app = appWith()
    expect((await upload(app)).statusCode).toBe(403)
    await app.close()
  })

  it('refuses everyone but the vault when no owner was named', async () => {
    // Not "allows everyone": an unnamed owner is a deployment that never said who this is for.
    const app = appWith({ config: { owner: null }, githubUser: { status: 200, login: 'octocat' } })
    expect((await upload(app, { authorization: 'Bearer gho_x' })).statusCode).toBe(403)
    await app.close()
  })

  it('refuses when GitHub cannot be reached to ask', async () => {
    const app = Fastify()
    app.decorate('isAuthenticated', () => false)
    registerUploadRoutes(app, {
      config: CONFIG,
      makeUploader: () => ({ name: 'fake', put: async () => 'https://cdn/x' }),
      fetch: (async () => { throw new TypeError('offline') }) as unknown as typeof globalThis.fetch,
    })
    expect((await upload(app, { authorization: 'Bearer gho_x' })).statusCode).toBe(403)
    await app.close()
  })
})

describe('what it accepts', () => {
  it('refuses a body that is not a picture-shaped request', async () => {
    const app = appWith({ signedIn: true })
    for (const payload of [
      {}, { bytes: '', ext: 'webp', hash: 'a1b2c3d4' },
      { bytes: PICTURE, ext: 'exe/../', hash: 'a1b2c3d4' },
      { bytes: PICTURE, ext: 'webp', hash: '../../etc' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/upload', payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    await app.close()
  })

  it('refuses one too big to be a re-encoded screenshot', async () => {
    const app = appWith({ signedIn: true })
    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      payload: { bytes: Buffer.alloc(9 * 1024 * 1024).toString('base64'), ext: 'webp', hash: 'a1b2c3d4' },
    })
    expect(res.statusCode).toBe(413)
    await app.close()
  })
})

describe('when the picture host says no', () => {
  it('answers 502 and says why, because the browser has somewhere else to put it', async () => {
    const app = appWith({
      signedIn: true,
      put: async () => { throw new UploadFailed('Qiniu refused it: bad token', 'refused') },
    })
    const res = await upload(app)
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toBe('Qiniu refused it: bad token')
    await app.close()
  })
})
