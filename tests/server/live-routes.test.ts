import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerLiveRoutes } from '../../src/server/live/routes.js'

/**
 * Who may open a socket that anybody with the link can write through.
 *
 * This is the half of live collaboration with a consequence if it is wrong. The blanket rule in
 * `auth.ts` cannot do the asking — the GitHub route has no session cookie, so a rule that demanded
 * one would shut out the person this is for — so the route asks, and these are the answers.
 *
 * The socket itself is `live-protocol.test.ts`; what it carries needs two documents and no server.
 */

function appWith(over: {
  signedIn?: boolean
  owner?: string | null
  githubUser?: { status: number; login?: string }
} = {}): FastifyInstance {
  const app = Fastify()
  app.decorate('isAuthenticated', () => over.signedIn === true)
  registerLiveRoutes(app, {
    config: { owner: over.owner === undefined ? 'octocat' : over.owner },
    fetch: (async () => {
      const who = over.githubUser ?? { status: 401 }
      return new Response(JSON.stringify({ login: who.login }), { status: who.status })
    }) as unknown as typeof globalThis.fetch,
  })
  return app
}

const NOTE = { path: 'notes/周会.md', title: '周会.md' }
const start = (app: FastifyInstance, headers: Record<string, string> = {}, note = NOTE) =>
  app.inject({ method: 'POST', url: '/api/live', headers, payload: note })

const AS_OWNER = { authorization: 'Bearer gho_real' }

describe('starting a session', () => {
  it('is refused with no credentials at all', async () => {
    const app = appWith()
    expect((await start(app)).statusCode).toBe(401)
    await app.close()
  })

  it('is refused for another account', async () => {
    const app = appWith({ githubUser: { status: 200, login: 'someone-else' } })
    expect((await start(app, AS_OWNER)).statusCode).toBe(401)
    await app.close()
  })

  it('is refused when the deployment named no owner: there is nobody to be answerable', async () => {
    const app = appWith({ owner: null, githubUser: { status: 200, login: 'octocat' } })
    expect((await start(app, AS_OWNER)).statusCode).toBe(401)
    await app.close()
  })

  it('works for the vault password, which is one owner and no name', async () => {
    const app = appWith({ signedIn: true })
    const res = await start(app)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ path: NOTE.path, title: NOTE.title, reclaim: false })
    await app.close()
  })

  it('hands back an id and a ticket, and the ticket is not the id', async () => {
    const app = appWith({ githubUser: { status: 200, login: 'octocat' } })
    const body = (await start(app, AS_OWNER)).json() as { id: string; ticket: string }
    expect(body.id).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/)
    expect(body.ticket.length).toBeGreaterThan(20)
    expect(body.ticket).not.toBe(body.id)
    await app.close()
  })

  it('is the same session twice for the same note, so a link already sent keeps working', async () => {
    const app = appWith({ signedIn: true })
    const first = (await start(app)).json() as { id: string; ticket: string }
    const again = (await start(app)).json() as { id: string; ticket: string }
    expect(again.id).toBe(first.id)
    expect(again.ticket).toBe(first.ticket)
    await app.close()
  })

  it('refuses a second note while one is running, and says which one is', async () => {
    const app = appWith({ signedIn: true })
    await start(app)
    const res = await start(app, {}, { path: 'notes/别的.md', title: '别的.md' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ path: NOTE.path })
    await app.close()
  })

  it('wants to know which note', async () => {
    const app = appWith({ signedIn: true })
    expect((await app.inject({ method: 'POST', url: '/api/live', payload: {} })).statusCode).toBe(400)
    await app.close()
  })
})

describe('what a guest is told', () => {
  it('is the note name and who shared it, and nothing about the vault', async () => {
    const app = appWith({ githubUser: { status: 200, login: 'octocat' } })
    const { id } = (await start(app, AS_OWNER)).json() as { id: string }
    const res = await app.inject({ method: 'GET', url: `/api/live/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ title: '周会.md', owner: 'octocat', guests: 0, full: false })
    await app.close()
  })

  it('needs no credentials: a link that needs an account is not a link', async () => {
    const app = appWith({ signedIn: false, githubUser: { status: 200, login: 'octocat' } })
    const { id } = (await start(app, AS_OWNER)).json() as { id: string }
    expect((await app.inject({ method: 'GET', url: `/api/live/${id}` })).statusCode).toBe(200)
    await app.close()
  })

  it('names no owner on a vault deployment, where there is one and they have no name', async () => {
    const app = appWith({ signedIn: true })
    const { id } = (await start(app)).json() as { id: string }
    expect((await app.inject({ method: 'GET', url: `/api/live/${id}` })).json())
      .toMatchObject({ owner: null })
    await app.close()
  })

  it('is one sentence for a link that ended and a link that never existed', async () => {
    const app = appWith({ signedIn: true })
    const { id } = (await start(app)).json() as { id: string }
    await app.inject({ method: 'DELETE', url: `/api/live/${id}` })

    const ended = await app.inject({ method: 'GET', url: `/api/live/${id}` })
    const never = await app.inject({ method: 'GET', url: '/api/live/zzzzzz' })
    expect(ended.statusCode).toBe(404)
    expect(never.statusCode).toBe(404)
    // The same words, because which one it was is a fact about somebody else's notes.
    expect(ended.json()).toEqual(never.json())
    await app.close()
  })
})

describe('the session this account is running', () => {
  it('is null when there is none, and null for a stranger', async () => {
    const app = appWith({ signedIn: true })
    expect((await app.inject({ method: 'GET', url: '/api/live/mine' })).json())
      .toEqual({ session: null })

    await start(app)
    const stranger = appWith({ githubUser: { status: 401 } })
    expect((await stranger.inject({ method: 'GET', url: '/api/live/mine' })).json())
      .toEqual({ session: null })
    await app.close()
    await stranger.close()
  })

  it('carries the ticket, which is how a reload lands back inside the session', async () => {
    const app = appWith({ signedIn: true })
    const started = (await start(app)).json() as { id: string; ticket: string }
    expect((await app.inject({ method: 'GET', url: '/api/live/mine' })).json())
      .toEqual({ session: { ...started, reclaim: false, guests: 0, path: NOTE.path, title: NOTE.title } })
    await app.close()
  })
})

describe('ending', () => {
  it('is for the account that started it, and a stranger holding the link is not it', async () => {
    const app = appWith({ githubUser: { status: 200, login: 'octocat' } })
    const { id } = (await start(app, AS_OWNER)).json() as { id: string }

    // A guest has the id — that is the whole point of the id — and no way to end the session.
    const stranger = await app.inject({ method: 'DELETE', url: `/api/live/${id}` })
    expect(stranger.statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: `/api/live/${id}` })).statusCode).toBe(200)
    await app.close()
  })

  it('is not an error twice: a second press is the same wish', async () => {
    const app = appWith({ signedIn: true })
    const { id } = (await start(app)).json() as { id: string }
    expect((await app.inject({ method: 'DELETE', url: `/api/live/${id}` })).json()).toEqual({ ended: true })
    expect((await app.inject({ method: 'DELETE', url: `/api/live/${id}` })).json()).toEqual({ ended: false })
    await app.close()
  })

  it('frees the account to start another note', async () => {
    const app = appWith({ signedIn: true })
    const { id } = (await start(app)).json() as { id: string }
    await app.inject({ method: 'DELETE', url: `/api/live/${id}` })
    expect((await start(app, {}, { path: 'notes/别的.md', title: '别的.md' })).statusCode).toBe(200)
    await app.close()
  })
})

describe('a deployment that did not ask for it', () => {
  it('has no routes at all, rather than routes that refuse', async () => {
    const app = Fastify()
    app.decorate('isAuthenticated', () => true)
    registerLiveRoutes(app, { config: null })
    expect((await app.inject({ method: 'POST', url: '/api/live', payload: NOTE })).statusCode).toBe(404)
    await app.close()
  })
})
