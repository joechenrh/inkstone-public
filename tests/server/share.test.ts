import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerShareRoutes } from '../../src/server/share/routes.js'
import { subsetFor } from '../../src/server/share/font.js'
import {
  LIFETIME_MS,
  MAX_CONTENT_BYTES,
  MAX_PER_ACCOUNT,
  MAX_SHARE_ASSET_BYTES,
  ShareStore,
  TOMBSTONE_MS,
} from '../../src/server/share/store.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-share-'))
  dirs.push(dir)
  return dir
}

const note = (over: Partial<Parameters<ShareStore['create']>[0]> = {}) => ({
  ownerId: 7,
  ownerLogin: 'octocat',
  repo: 'octocat/notes',
  path: 'notes/a.md',
  title: 'A note',
  content: '# A note\n\nbody\n',
  ...over,
})

describe('the share store', () => {
  it('round-trips a note, and hands back a readable id', async () => {
    const store = await ShareStore.open(await scratch())
    const meta = await store.create(note(), T0)

    expect(meta.id).toMatch(/^[a-z2-9]{6}$/)
    // Nothing ambiguous when read aloud or retyped.
    expect(meta.id).not.toMatch(/[ilo01]/)
    expect(meta.expiresAt).toBe(T0 + LIFETIME_MS)

    const found = await store.read(meta.id, T0 + DAY)
    expect(found).toMatchObject({ ok: true, content: '# A note\n\nbody\n' })
  })

  it('keeps the link and replaces the text when the same note is shared again', async () => {
    const store = await ShareStore.open(await scratch())
    const first = await store.create(note(), T0)
    const again = await store.create(note({ content: 'rewritten' }), T0 + 10 * DAY)

    // The whole reason there is no separate Extend control: the link a person already sent
    // must keep working.
    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(T0)
    expect(again.expiresAt).toBe(T0 + 10 * DAY + LIFETIME_MS)

    const found = await store.read(first.id, T0 + 11 * DAY)
    expect(found).toMatchObject({ ok: true, content: 'rewritten' })
  })

  it('treats the same path in another repository, and another account, as another share', async () => {
    const store = await ShareStore.open(await scratch())
    const mine = await store.create(note(), T0)
    const other = await store.create(note({ repo: 'octocat/work' }), T0)
    const theirs = await store.create(note({ ownerId: 8, ownerLogin: 'someone' }), T0)

    expect(new Set([mine.id, other.id, theirs.id]).size).toBe(3)
  })

  it('refuses a note past the cap, saying how big it is', async () => {
    const store = await ShareStore.open(await scratch())
    await expect(store.create(note({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) }), T0))
      // Rounded up: one byte over must not report the cap itself back as the size.
      .rejects.toMatchObject({ kind: 'too-large', message: 'this note is 65KB' })
  })

  it('counts a multi-byte note in bytes, not characters', async () => {
    const store = await ShareStore.open(await scratch())
    // 3 bytes each in UTF-8, so this is over the cap while being a third of it in characters.
    const chinese = '一'.repeat(Math.ceil(MAX_CONTENT_BYTES / 3) + 1)
    expect(chinese.length).toBeLessThan(MAX_CONTENT_BYTES)
    await expect(store.create(note({ content: chinese }), T0)).rejects.toMatchObject({ kind: 'too-large' })
  })

  it('caps how many an account can have at once, and frees a slot when one is stopped', async () => {
    const store = await ShareStore.open(await scratch())
    for (let i = 0; i < MAX_PER_ACCOUNT; i += 1) {
      await store.create(note({ path: `notes/${i}.md` }), T0)
    }
    await expect(store.create(note({ path: 'notes/one-too-many.md' }), T0))
      .rejects.toMatchObject({ kind: 'too-many' })

    // Extending an existing one is not a new share, so it stays allowed at the cap.
    await expect(store.create(note({ path: 'notes/0.md' }), T0)).resolves.toBeDefined()

    const mine = store.listFor(7, T0)
    await store.stop(mine[0]!.id, 7, T0)
    await expect(store.create(note({ path: 'notes/one-too-many.md' }), T0)).resolves.toBeDefined()
  })

  it('tells expired, stopped and never-existed apart', async () => {
    const store = await ShareStore.open(await scratch())
    const expiring = await store.create(note({ path: 'a.md' }), T0)
    const stopping = await store.create(note({ path: 'b.md' }), T0)
    await store.stop(stopping.id, 7, T0)

    expect(await store.read(expiring.id, T0 + LIFETIME_MS + 1)).toEqual({ ok: false, reason: 'expired' })
    expect(await store.read(stopping.id, T0 + DAY)).toEqual({ ok: false, reason: 'stopped' })
    expect(await store.read('zzzzzz', T0)).toEqual({ ok: false, reason: 'missing' })
  })

  it('drops the text the moment an expired link is opened', async () => {
    const dir = await scratch()
    const store = await ShareStore.open(dir)
    const meta = await store.create(note(), T0)

    await store.read(meta.id, T0 + LIFETIME_MS + 1)
    await expect(fs.access(path.join(dir, `${meta.id}.md`))).rejects.toThrow()
    // And the record stays, which is what keeps "expired" distinguishable from "never existed".
    await expect(fs.access(path.join(dir, `${meta.id}.json`))).resolves.toBeUndefined()
  })

  it('will not let one account stop another account\'s share', async () => {
    const store = await ShareStore.open(await scratch())
    const meta = await store.create(note(), T0)

    expect(await store.stop(meta.id, 8, T0)).toBe(false)
    expect(await store.read(meta.id, T0)).toMatchObject({ ok: true })
    expect(await store.stop(meta.id, 7, T0)).toBe(true)
  })

  it('sweeps the text of a share nobody ever opened, then the record itself', async () => {
    const dir = await scratch()
    const store = await ShareStore.open(dir)
    const meta = await store.create(note(), T0)

    // A share that expires unread is the case expiry alone never collects.
    expect(await store.sweep(T0 + LIFETIME_MS + DAY)).toEqual({ emptied: 1, removed: 0 })
    await expect(fs.access(path.join(dir, `${meta.id}.md`))).rejects.toThrow()
    // Idempotent: a second pass finds nothing left to empty.
    expect(await store.sweep(T0 + LIFETIME_MS + 2 * DAY)).toEqual({ emptied: 0, removed: 0 })

    expect(await store.sweep(T0 + LIFETIME_MS + TOMBSTONE_MS + 1)).toEqual({ emptied: 0, removed: 1 })
    expect(store.size()).toBe(0)
    await expect(fs.access(path.join(dir, `${meta.id}.json`))).rejects.toThrow()
    expect(await store.read(meta.id, T0 + LIFETIME_MS + TOMBSTONE_MS + 2))
      .toEqual({ ok: false, reason: 'missing' })
  })

  it('finds its shares again after a restart', async () => {
    const dir = await scratch()
    const first = await ShareStore.open(dir)
    const meta = await first.create(note(), T0)

    const second = await ShareStore.open(dir)
    expect(second.listFor(7, T0).map((m) => m.id)).toEqual([meta.id])
    expect(await second.read(meta.id, T0)).toMatchObject({ ok: true, content: '# A note\n\nbody\n' })
  })

  it('starts rather than refusing when a record on disk is unreadable', async () => {
    const dir = await scratch()
    await fs.writeFile(path.join(dir, 'broken.json'), 'not json')
    const store = await ShareStore.open(dir)
    expect(store.size()).toBe(0)
    await expect(store.create(note(), T0)).resolves.toBeDefined()
  })
})

/** A GitHub that answers for one token and refuses everything else. */
function githubFor(tokens: Record<string, { id: number; login: string }>) {
  let calls = 0
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1
    const auth = String((init?.headers as Record<string, string>).authorization ?? '')
    const user = tokens[auth.replace('Bearer ', '')]
    return user === undefined
      ? new Response('{}', { status: 401 })
      : new Response(JSON.stringify(user), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls: () => calls }
}

interface Harness {
  app: FastifyInstance
  store: ShareStore
  calls: () => number
  at: (t: number) => void
}

async function serve(over: { tokens?: Record<string, { id: number; login: string }> } = {}): Promise<Harness> {
  const store = await ShareStore.open(await scratch())
  const github = githubFor(over.tokens ?? { 'good-token': { id: 7, login: 'octocat' } })
  let clock = T0
  const app = Fastify()
  registerShareRoutes(app, { store, fetch: github.fetch, now: () => clock })
  return { app, store, calls: github.calls, at: (t) => { clock = t } }
}

const auth = (token = 'good-token') => ({ authorization: `Bearer ${token}` })
const body = { repo: 'octocat/notes', path: 'notes/a.md', title: 'A note', content: 'hello' }

describe('the share routes', () => {
  it('shares a note and reads it back with no credentials at all', async () => {
    const { app } = await serve()
    const made = await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: body })
    expect(made.statusCode).toBe(200)
    const { id } = made.json() as { id: string }

    // No Authorization header: this is the whole point of a link.
    const read = await app.inject({ method: 'GET', url: `/api/share/${id}` })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({ title: 'A note', content: 'hello', path: 'notes/a.md' })
    await app.close()
  })

  it('never puts the sharer in what the reader is given', async () => {
    const { app } = await serve()
    const { id } = (await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: body })).json() as { id: string }
    const read = (await app.inject({ method: 'GET', url: `/api/share/${id}` })).json() as Record<string, unknown>

    // A reader's copy is theirs. Who shared it belongs in the text the sharer wrote, if anywhere.
    expect(Object.keys(read).sort()).toEqual(['content', 'expiresAt', 'hasFont', 'path', 'sharedAt', 'title'])
    expect(JSON.stringify(read)).not.toContain('octocat')
    await app.close()
  })

  it('refuses to share without a token, and says so in words a person can act on', async () => {
    const { app } = await serve()
    const res = await app.inject({ method: 'POST', url: '/api/share', payload: body })
    expect(res.statusCode).toBe(401)
    expect((res.json() as { error: string }).error).toBe('Your session ended. Sign in and share again.')
    await app.close()
  })

  it('refuses a token GitHub does not recognise', async () => {
    const { app } = await serve()
    const res = await app.inject({ method: 'POST', url: '/api/share', headers: auth('stale'), payload: body })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('says 503, not 401, when this server cannot reach GitHub', async () => {
    const store = await ShareStore.open(await scratch())
    const app = Fastify()
    registerShareRoutes(app, {
      store,
      fetch: (() => Promise.reject(new Error('ENETUNREACH'))) as unknown as typeof globalThis.fetch,
    })
    const res = await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: body })
    // "Sign in again" would send someone round a loop that cannot end.
    expect(res.statusCode).toBe(503)
    await app.close()
  })

  it('asks GitHub once for a burst of shares', async () => {
    const { app, calls } = await serve()
    for (const p of ['a.md', 'b.md', 'c.md']) {
      await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: { ...body, path: p } })
    }
    expect(calls()).toBe(1)
    await app.close()
  })

  it('reports the two limits distinguishably, with the numbers in them', async () => {
    const { app } = await serve()
    const big = await app.inject({
      method: 'POST', url: '/api/share', headers: auth(),
      payload: { ...body, content: 'x'.repeat(MAX_CONTENT_BYTES + 1) },
    })
    expect(big.statusCode).toBe(413)
    expect(big.json()).toMatchObject({ kind: 'too-large', maxBytes: MAX_CONTENT_BYTES })

    for (let i = 0; i < MAX_PER_ACCOUNT; i += 1) {
      await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: { ...body, path: `n/${i}.md` } })
    }
    const many = await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: { ...body, path: 'n/x.md' } })
    expect(many.statusCode).toBe(409)
    expect(many.json()).toMatchObject({ kind: 'too-many', limit: MAX_PER_ACCOUNT })
    await app.close()
  })

  it('lists what this account has shared, and nobody else\'s', async () => {
    const { app } = await serve({
      tokens: { 'good-token': { id: 7, login: 'octocat' }, 'other-token': { id: 8, login: 'someone' } },
    })
    await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: body })
    await app.inject({ method: 'POST', url: '/api/share', headers: auth('other-token'), payload: body })

    const mine = (await app.inject({ method: 'GET', url: '/api/shares', headers: auth() })).json() as { shares: unknown[] }
    expect(mine.shares).toHaveLength(1)
    expect(mine.shares[0]).toMatchObject({ path: 'notes/a.md', repo: 'octocat/notes' })
    await app.close()
  })

  it('stops a share, and refuses to stop somebody else\'s', async () => {
    const { app } = await serve({
      tokens: { 'good-token': { id: 7, login: 'octocat' }, 'other-token': { id: 8, login: 'someone' } },
    })
    const { id } = (await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: body })).json() as { id: string }

    expect((await app.inject({ method: 'DELETE', url: `/api/share/${id}`, headers: auth('other-token') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/share/${id}`, headers: auth() })).statusCode).toBe(204)

    const gone = await app.inject({ method: 'GET', url: `/api/share/${id}` })
    expect(gone.statusCode).toBe(404)
    expect(gone.json()).toEqual({ reason: 'stopped' })
    await app.close()
  })

  it('gives the reader a reason rather than a bare 404', async () => {
    const { app, at } = await serve()
    const { id } = (await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: body })).json() as { id: string }

    at(T0 + LIFETIME_MS + 1)
    expect((await app.inject({ method: 'GET', url: `/api/share/${id}` })).json()).toEqual({ reason: 'expired' })
    expect((await app.inject({ method: 'GET', url: '/api/share/zzzzzz' })).json()).toEqual({ reason: 'missing' })
    await app.close()
  })

  it('tells caches not to keep a shared note', async () => {
    const { app } = await serve()
    const { id } = (await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: body })).json() as { id: string }
    const read = await app.inject({ method: 'GET', url: `/api/share/${id}` })
    // Stopping a share must not be undone by a proxy that kept a copy.
    expect(read.headers['cache-control']).toBe('no-store')
    await app.close()
  })

  it('registers nothing at all when the server was given nowhere to keep shares', async () => {
    const app = Fastify()
    registerShareRoutes(app, { store: null })
    for (const url of ['/api/share/abc123', '/api/shares']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404)
    }
    await app.close()
  })
})

describe('the face a shared note carries', () => {
  it('cuts nothing for a note with no Chinese in it', async () => {
    // The common case in the Latin world, and it costs those readers nothing at all — the same
    // reasoning as the `unicode-range` in fonts.css.
    expect(await subsetFor('# Hello\n\nJust prose, a `code span`, and 123.')).toBeNull()
  })

  it('cuts one that has, and only to the characters it uses', async () => {
    const cut = await subsetFor('# 一篇中文笔记\n\n第一段正文，读起来和在编辑器里一样。')
    expect(cut).not.toBeNull()
    // Against the 1.0MB and 1.1MB faces the app ships: this is the whole point.
    expect(cut!.regular.length).toBeLessThan(60 * 1024)
    expect(cut!.bold.length).toBeLessThan(60 * 1024)
    // woff2 magic, so this is a font and not an error page.
    expect(cut!.regular.subarray(0, 4).toString('latin1')).toBe('wOF2')
  }, 30_000)

  it('stores the face with the note, replaces it with the note, and drops it with the note', async () => {
    const dir = await scratch()
    const store = await ShareStore.open(dir)
    const fonts = { regular: Buffer.from('wOF2-regular'), bold: Buffer.from('wOF2-bold') }
    const meta = await store.create(note({ content: '中文' , fonts }), T0)

    expect(await store.hasFont(meta.id)).toBe(true)
    expect((await store.font(meta.id, 'regular'))?.toString()).toBe('wOF2-regular')

    // Re-shared with no Chinese left in it: the previous note's glyphs must not survive.
    await store.create(note({ content: 'now in English', fonts: null }), T0)
    expect(await store.hasFont(meta.id)).toBe(false)

    await store.create(note({ content: '中文', fonts }), T0)
    await store.stop(meta.id, 7, T0)
    expect(await store.hasFont(meta.id)).toBe(false)
  })

  it('serves the face to anyone with the link, and 404s the rest', async () => {
    const { app, store } = await serve()
    const made = await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: { ...body, content: '中文笔记' } })
    const { id } = made.json() as { id: string }
    expect(await store.hasFont(id)).toBe(true)

    // No credentials: the face is as public as the note it belongs to.
    const face = await app.inject({ method: 'GET', url: `/api/share/${id}/font/regular.woff2` })
    expect(face.statusCode).toBe(200)
    expect(face.headers['content-type']).toBe('font/woff2')
    // Revalidated, never immutable: the id outlives a re-share, so these bytes change.
    expect(face.headers['cache-control']).toContain('must-revalidate')

    expect((await app.inject({ method: 'GET', url: `/api/share/${id}/font/heavy.woff2` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/share/zzzzzz/font/bold.woff2' })).statusCode).toBe(404)
    await app.close()
  }, 30_000)

  it('tells the reader whether there is one, so it can prefer it', async () => {
    const { app } = await serve()
    const plain = (await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: body })).json() as { id: string }
    expect((await app.inject({ method: 'GET', url: `/api/share/${plain.id}` })).json()).toMatchObject({ hasFont: false })
    await app.close()
  })
})

describe('a share made before notes carried a face', () => {
  it('gets one on its first read, without being re-shared', async () => {
    const { app, store } = await serve()
    const made = await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: { ...body, content: '一篇中文笔记' } })
    const { id } = made.json() as { id: string }

    // Wind it back to what an older share looks like on disk: text, no face.
    await store.stop(id, 7, T0)
    expect(await store.hasFont(id)).toBe(false)

    const { app: fresh, store: store2 } = await serve()
    const older = (await fresh.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: { ...body, content: '一篇中文笔记' } })).json() as { id: string }
    await fs.rm(path.join((store2 as unknown as { root: string }).root, `${older.id}-regular.woff2`))
    await fs.rm(path.join((store2 as unknown as { root: string }).root, `${older.id}-bold.woff2`))
    expect(await store2.hasFont(older.id)).toBe(false)

    const read = await fresh.inject({ method: 'GET', url: `/api/share/${older.id}` })
    expect(read.json()).toMatchObject({ hasFont: true })
    expect(await store2.hasFont(older.id)).toBe(true)
    await app.close()
    await fresh.close()
  }, 40_000)
})

/**
 * The pictures a shared note carries.
 *
 * The same argument as the face: a share is a copy, and the alternative here is a link back into a
 * private repository the reader has no account for. So the bytes travel with the note, are replaced
 * with it, and stop being served the moment it does.
 */
describe('a shared note and its pictures', () => {
  const NAME = '0123456789abcdef.webp'
  const picture = (name = NAME, bytes = 'aGVsbG8=') => ({ name, bytes })

  it('serves them to anyone with the link, cached for ever', async () => {
    const { app } = await serve()
    const made = await app.inject({
      method: 'POST', url: '/api/share', headers: auth(),
      payload: { ...body, content: `![](/assets/${NAME})`, assets: [picture()] },
    })
    const { id } = made.json() as { id: string }

    // No credentials: as public as the note it belongs to.
    const got = await app.inject({ method: 'GET', url: `/api/share/${id}/asset/${NAME}` })
    expect(got.statusCode).toBe(200)
    expect(got.headers['content-type']).toBe('image/webp')
    expect(got.rawPayload.toString()).toBe('hello')
    // Immutable, where the face is revalidated: a picture's name is the hash of its own bytes, so
    // this one can never come to mean anything else.
    expect(got.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(got.headers['x-content-type-options']).toBe('nosniff')
    await app.close()
  })

  it('replaces the set when the note is shared again', async () => {
    const { app, store } = await serve()
    const made = await app.inject({
      method: 'POST', url: '/api/share', headers: auth(),
      payload: { ...body, assets: [picture()] },
    })
    const { id } = made.json() as { id: string }

    const other = 'fedcba9876543210.webp'
    await app.inject({
      method: 'POST', url: '/api/share', headers: auth(),
      payload: { ...body, assets: [picture(other, 'd29ybGQ=')] },
    })

    // The picture taken out of the note stops being served with it.
    expect(await store.asset(id, NAME)).toBeNull()
    expect((await store.asset(id, other))?.toString()).toBe('world')
    await app.close()
  })

  it('stops serving them the moment the note stops', async () => {
    const { app, store } = await serve()
    const made = await app.inject({
      method: 'POST', url: '/api/share', headers: auth(),
      payload: { ...body, assets: [picture()] },
    })
    const { id } = made.json() as { id: string }

    await store.stop(id, 7, T0)
    const got = await app.inject({ method: 'GET', url: `/api/share/${id}/asset/${NAME}` })
    expect(got.statusCode).toBe(404)
    expect(await store.asset(id, NAME)).toBeNull()
    await app.close()
  })

  it('will not build a path out of a name it was handed', async () => {
    const { app, store } = await serve()
    const made = await app.inject({
      method: 'POST', url: '/api/share', headers: auth(),
      payload: {
        ...body,
        assets: [
          picture('../../etc/passwd'),
          picture('0123456789abcdef.svg'),
          picture('short.webp'),
          picture(),
        ],
      },
    })
    const { id } = made.json() as { id: string }

    // Only the one that is the shape a picture's name actually has.
    expect((await store.asset(id, NAME))?.toString()).toBe('hello')
    expect(await store.asset(id, '../../etc/passwd')).toBeNull()
    expect((await app.inject({ method: 'GET', url: `/api/share/${id}/asset/0123456789abcdef.svg` })).statusCode).toBe(404)
    await app.close()
  })

  it('refuses a set that is too large, and says what it came to', async () => {
    const { app } = await serve()
    const big = Buffer.alloc(2 * 1024 * 1024 + 1024, 1).toString('base64')
    const made = await app.inject({
      method: 'POST', url: '/api/share', headers: auth(),
      payload: { ...body, assets: [picture('0123456789abcdef.webp', big), picture('fedcba9876543210.webp', big)] },
    })

    expect(made.statusCode).toBe(413)
    expect(made.json()).toMatchObject({ kind: 'too-large', maxBytes: MAX_SHARE_ASSET_BYTES })
    // The number it was refused on, not the cap: "too large" without a size is a wall.
    expect((made.json() as { error: string }).error).toMatch(/\d+KB/)
    await app.close()
  })

  it('shares a note with no pictures exactly as before', async () => {
    const { app, store } = await serve()
    const made = await app.inject({ method: 'POST', url: '/api/share', headers: auth(), payload: body })
    expect(made.statusCode).toBe(200)
    expect(await store.asset((made.json() as { id: string }).id, NAME)).toBeNull()
    await app.close()
  })
})
