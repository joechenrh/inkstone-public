import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerLiveRoutes } from '../../src/server/live/routes.js'

/**
 * The agent's half of the surface, and who may reach it.
 *
 * The session's own routes are `live-routes.test.ts`; these are the two an outside program calls.
 * Every refusal is asserted for its *words*, not only its code: the caller is a language model, and
 * the words are the only thing that tells it what to do next.
 */

async function sessionWith(): Promise<{ app: FastifyInstance; id: string; token: string }> {
  const app = Fastify()
  app.decorate('isAuthenticated', () => true)
  registerLiveRoutes(app, { config: { owner: null } })
  const started = (await app.inject({
    method: 'POST',
    url: '/api/live',
    payload: { path: 'notes/weekly.md', title: 'weekly.md' },
  })).json() as { id: string; agentToken: string }
  return { app, id: started.id, token: started.agentToken }
}

describe('reading a session as an agent', () => {
  it('needs the agent token, and the session id is not it', async () => {
    const { app, id } = await sessionWith()
    expect((await app.inject({ method: 'GET', url: `/api/live/${id}/text` })).statusCode).toBe(401)
    const asId = await app.inject({
      method: 'GET',
      url: `/api/live/${id}/text`,
      headers: { authorization: `Bearer ${id}` },
    })
    expect(asId.statusCode).toBe(401)
    expect(asId.json()).toMatchObject({ hint: expect.stringContaining('not the session id') })
    await app.close()
  })

  it('answers the note, the version, who is editing and whether anybody can apply an edit', async () => {
    const { app, id, token } = await sessionWith()
    const res = await app.inject({
      method: 'GET',
      url: `/api/live/${id}/text`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      note: 'notes/weekly.md',
      version: 0,
      text: '',
      editors: [],
      // Nobody has opened a socket in this test, so there are no hands.
      applying: false,
    })
    await app.close()
  })

  it('says one sentence for a session that is not running, whoever asks', async () => {
    const { app, token } = await sessionWith()
    const res = await app.inject({
      method: 'GET',
      url: '/api/live/zzzzzz/text',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({
      error: 'no such session',
      hint: expect.stringContaining('ask whoever gave you the link'),
    })
    await app.close()
  })
})

describe('the token itself', () => {
  it('is handed to the owner when they start, and again when they come back', async () => {
    const { app, token } = await sessionWith()
    expect(token.length).toBeGreaterThan(20)
    const mine = (await app.inject({ method: 'GET', url: '/api/live/mine' })).json() as {
      session: { agentToken: string }
    }
    expect(mine.session.agentToken).toBe(token)
    await app.close()
  })

  it('is not the owner\u2019s socket ticket: two credentials, two jobs', async () => {
    const app = Fastify()
    app.decorate('isAuthenticated', () => true)
    registerLiveRoutes(app, { config: { owner: null } })
    const started = (await app.inject({
      method: 'POST',
      url: '/api/live',
      payload: { path: 'notes/a.md', title: 'a.md' },
    })).json() as { ticket: string; agentToken: string }
    expect(started.agentToken).not.toBe(started.ticket)
    await app.close()
  })
})

describe('editing a session as an agent', () => {
  const edit = (app: FastifyInstance, id: string, token: string, body: unknown) => app.inject({
    method: 'POST',
    url: `/api/live/${id}/edit`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body as never,
  })

  it('needs the agent token like the read does', async () => {
    const { app, id } = await sessionWith()
    const res = await app.inject({
      method: 'POST',
      url: `/api/live/${id}/edit`,
      headers: { 'content-type': 'application/json' },
      payload: { ops: [{ append: 'x' }] },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('refuses a whole document, and says what to send instead', async () => {
    const { app, id, token } = await sessionWith()
    const res = await edit(app, id, token, { text: 'the whole note' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({
      error: expect.stringContaining('send ops'),
      hint: expect.stringContaining('anchor on text'),
    })
    await app.close()
  })

  it('refuses more than twenty ops', async () => {
    const { app, id, token } = await sessionWith()
    const res = await edit(app, id, token, {
      ops: Array.from({ length: 21 }, () => ({ append: 'x' })),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: 'too many ops: 20 at a time' })
    await app.close()
  })

  it('says nobody is applying when no browser is connected, rather than hanging', async () => {
    const { app, id, token } = await sessionWith()
    const res = await edit(app, id, token, { ops: [{ append: 'x' }], waitMs: 40 })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({
      error: 'nobody is applying edits right now',
      hint: 'the session has no connected editor at the moment — wait a few seconds and retry',
    })
    await app.close()
  })

  it('refuses a stale version with the current text, so the agent can redo its own work', async () => {
    const { app, id, token } = await sessionWith()
    const stale = await edit(app, id, token, { version: 99, ops: [{ append: 'x' }] })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({
      error: 'the note moved',
      version: 0,
      text: '',
      hint: expect.stringContaining('re-read'),
    })
    await app.close()
  })

  it('takes a version that is current, and then goes looking for a browser', async () => {
    const { app, id, token } = await sessionWith()
    // Version 0 is current here, so this gets past the check and fails for the honest reason.
    const res = await edit(app, id, token, { version: 0, ops: [{ append: 'x' }], waitMs: 40 })
    expect(res.statusCode).toBe(503)
    await app.close()
  })

})

describe('the rate limit', () => {
  it('lets sixty requests a minute through and then says to wait', async () => {
    const { app, id, token } = await sessionWith()
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({
        method: 'GET', url: `/api/live/${id}/text`, headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode, `request ${i}`).toBe(200)
    }
    const over = await app.inject({
      method: 'GET', url: `/api/live/${id}/text`, headers: { authorization: `Bearer ${token}` },
    })
    expect(over.statusCode).toBe(429)
    expect(over.json()).toMatchObject({ hint: expect.stringContaining('wait') })
    await app.close()
  })

  it('is not spent by requests it was never going to serve', async () => {
    const { app, id, token } = await sessionWith()
    // Seventy refusals is past the minute's worth. If the counter ran before the token check, a
    // stranger with the link could lock the owner's own agent out of its session.
    for (let i = 0; i < 70; i++) {
      const refused = await app.inject({
        method: 'GET', url: `/api/live/${id}/text`, headers: { authorization: 'Bearer wrong' },
      })
      expect(refused.statusCode, `attempt ${i}`).toBe(401)
    }
    const mine = await app.inject({
      method: 'GET', url: `/api/live/${id}/text`, headers: { authorization: `Bearer ${token}` },
    })
    expect(mine.statusCode).toBe(200)
    await app.close()
  })
})

describe('the agent in the room', () => {
  it('appears in the presence list, so the owner can see it is there', async () => {
    const { app, id, token } = await sessionWith()
    await app.inject({
      method: 'POST',
      url: `/api/live/${id}/edit`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { ops: [{ append: 'x' }], waitMs: 20 },
    })
    const res = await app.inject({
      method: 'GET', url: `/api/live/${id}/text`, headers: { authorization: `Bearer ${token}` },
    })
    // Its edits wear the host's name, so this list is the only place it is visible.
    expect((res.json() as { editors: { name: string; color: string }[] }).editors)
      .toContainEqual({ name: 'agent', color: '#7a4fa3' })
    await app.close()
  })

  it('is not in an empty room: a name nobody is using is a ghost', async () => {
    const { app, id, token } = await sessionWith()
    const res = await app.inject({
      method: 'GET', url: `/api/live/${id}/text`, headers: { authorization: `Bearer ${token}` },
    })
    expect((res.json() as { editors: unknown[] }).editors).toEqual([])
    await app.close()
  })
})
