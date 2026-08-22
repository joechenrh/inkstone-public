import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { login, makeTestApp, type TestApp } from '../helpers/app.js'

let t: TestApp
let cookie: string

beforeEach(async () => {
  t = await makeTestApp()
  cookie = await login(t)
})

afterEach(async () => {
  await t.cleanup()
})

const auth = () => ({ cookie })

describe('GET /api/tree', () => {
  it('returns an entry tree with directories first', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/tree', headers: auth() })
    expect(res.statusCode).toBe(200)
    const tree = res.json()
    expect(tree[0].name).toBe('notes')
    expect(tree[0].children[0].path).toBe('notes/a.md')
  })
})

describe('GET /api/file', () => {
  it('returns content and mtime', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/file?path=notes%2Fa.md',
      headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().content).toBe('# a\n')
    expect(res.json().mtimeMs).toBeGreaterThan(0)
  })

  it('returns 404 for a non-existent file', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/file?path=nope.md', headers: auth() })
    expect(res.statusCode).toBe(404)
  })

  it('traversal paths return 400 rather than 404 and do not leak filesystem information', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/file?path=..%2F..%2Fetc%2Fpasswd',
      headers: auth(),
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain('/etc')
  })

  it('returns 400 when the path parameter is missing', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/file', headers: auth() })
    expect(res.statusCode).toBe(400)
  })
})

describe('PUT /api/file', () => {
  it('writes and returns the new mtime', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md', content: '# changed\n' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().mtimeMs).toBeGreaterThan(0)
    expect(await fs.readFile(path.join(t.root, 'notes/a.md'), 'utf8')).toBe('# changed\n')
  })

  it('writes normally when baseMtimeMs matches disk', async () => {
    const read = await t.app.inject({
      method: 'GET',
      url: '/api/file?path=notes%2Fa.md',
      headers: auth(),
    })
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md', content: 'ok\n', baseMtimeMs: read.json().mtimeMs },
    })
    expect(res.statusCode).toBe(200)
  })

  it('returns 409 with the current disk state when baseMtimeMs is stale', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md', content: 'mine\n', baseMtimeMs: 1 },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().disk.content).toBe('# a\n')
    expect(await fs.readFile(path.join(t.root, 'notes/a.md'), 'utf8')).toBe('# a\n')
  })

  it('returns 400 when content is not a string', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md', content: 42 },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/file', () => {
  it('returns 201 when creating a file', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/b.md', kind: 'file' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('returns 201 when creating a directory', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'journal', kind: 'dir' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('returns 409 when the path already exists', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md', kind: 'file' },
    })
    expect(res.statusCode).toBe(409)
  })

  // Fix round 1 / Finding 3: creating a file/dir mutates the vault just like
  // PUT and DELETE do, but was missing from the notifyWrite() wiring — a new
  // note would sit uncommitted until some unrelated write happened to flip
  // the flag. Spying on the same autoCommit instance buildApp wired up (see
  // helpers/app.ts) rather than a fresh double, so this exercises the real
  // wiring path.
  it('marks AutoCommit dirty after successful creation', async () => {
    const spy = vi.spyOn(t.autoCommit, 'notifyWrite')
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/c.md', kind: 'file' },
    })
    expect(res.statusCode).toBe(201)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not mark AutoCommit dirty when creation fails because the path already exists', async () => {
    const spy = vi.spyOn(t.autoCommit, 'notifyWrite')
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md', kind: 'file' },
    })
    expect(res.statusCode).toBe(409)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('POST /api/file/rename', () => {
  it('returns 204 on rename', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file/rename',
      headers: auth(),
      payload: { from: 'notes/a.md', to: 'notes/b.md' },
    })
    expect(res.statusCode).toBe(204)
  })

  it('returns 409 when the target already exists', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/b.md', kind: 'file' },
    })
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file/rename',
      headers: auth(),
      payload: { from: 'notes/a.md', to: 'notes/b.md' },
    })
    expect(res.statusCode).toBe(409)
  })

  // Fix round 1 / Finding 3: same gap as POST /api/file — a rename mutates
  // the vault but wasn't wired to notifyWrite(), so a renamed note wouldn't
  // get an autosave commit until an unrelated write happened.
  it('marks AutoCommit dirty after a successful rename', async () => {
    const spy = vi.spyOn(t.autoCommit, 'notifyWrite')
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file/rename',
      headers: auth(),
      payload: { from: 'notes/a.md', to: 'notes/renamed.md' },
    })
    expect(res.statusCode).toBe(204)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not mark AutoCommit dirty when rename fails because the target already exists', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/b.md', kind: 'file' },
    })
    const spy = vi.spyOn(t.autoCommit, 'notifyWrite')
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file/rename',
      headers: auth(),
      payload: { from: 'notes/a.md', to: 'notes/b.md' },
    })
    expect(res.statusCode).toBe(409)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/file', () => {
  it('returns 204 on delete', async () => {
    const res = await t.app.inject({
      method: 'DELETE',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md' },
    })
    expect(res.statusCode).toBe(204)
  })
})

describe('GET /api/git/status', () => {
  it('returns dirty flag and branch name', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/git/status', headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ dirty: false, branch: 'main' })
  })
})

describe('GET /api/git/status extended', () => {
  it('hasRemote=false and ahead=0 when there is no remote', async () => {
    const t2 = await makeTestApp()
    const cookie2 = await login(t2)
    const res = await t2.app.inject({ method: 'GET', url: '/api/git/status', headers: { cookie: cookie2 } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ hasRemote: false, ahead: 0 })
    await t2.cleanup()
  })
})

describe('POST /api/git/commit', () => {
  it('commits when there are changes and returns the sha', async () => {
    const t2 = await makeTestApp()
    const cookie2 = await login(t2)
    await t2.app.inject({ method: 'PUT', url: '/api/file', headers: { cookie: cookie2 }, payload: { path: 'notes/a.md', content: 'changed\n' } })
    const res = await t2.app.inject({ method: 'POST', url: '/api/git/commit', headers: { cookie: cookie2 }, payload: { message: 'manual: test' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().sha).toMatch(/^[0-9a-f]{40}$/)
    await t2.cleanup()
  })
  it('returns null when there are no changes', async () => {
    const t2 = await makeTestApp()
    const cookie2 = await login(t2)
    const res = await t2.app.inject({ method: 'POST', url: '/api/git/commit', headers: { cookie: cookie2 }, payload: { message: 'x' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
    await t2.cleanup()
  })
})

describe('POST /api/git/push', () => {
  it('returns 409 and does not leak paths when there is no upstream', async () => {
    const t2 = await makeTestApp()
    const cookie2 = await login(t2)
    const res = await t2.app.inject({ method: 'POST', url: '/api/git/push', headers: { cookie: cookie2 } })
    expect(res.statusCode).toBe(409)
    expect(res.body).not.toContain(t2.root)
    await t2.cleanup()
  })
})

describe('GET /api/vault/info', () => {
  it('returns the configured root', async () => {
    const t2 = await makeTestApp()
    const cookie2 = await login(t2)
    const res = await t2.app.inject({ method: 'GET', url: '/api/vault/info', headers: { cookie: cookie2 } })
    expect(res.statusCode).toBe(200)
    expect(res.json().root).toBe(t2.root)
    await t2.cleanup()
  })
  it('returns 401 when unauthenticated', async () => {
    const t2 = await makeTestApp()
    expect((await t2.app.inject({ method: 'GET', url: '/api/vault/info' })).statusCode).toBe(401)
    await t2.cleanup()
  })
})

// Regression tests for a Task 6 decision: after Task 3, the vault layer gained
// several VaultError variants beyond "not found / already exists" (path segment
// is not a directory, target is a directory, parent directory does not exist,
// unclassified fs failure). sendVaultError's original prefix dispatch only
// covered two categories; everything else fell into the 400 fallback — which is
// misleading for "unclassified fs failure" (a server/environment problem
// reported to the client as "your request is wrong"). These tests trigger each
// variant through a real request path to confirm it lands on the expected status
// code rather than being silently swallowed by the 400 default.
describe('sendVaultError classification of new VaultError variants', () => {
  it('writing to a path that is already a directory (EISDIR) returns 409 not the default 400', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes', content: 'oops' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('an intermediate path segment that is a file not a directory (ENOTDIR/EEXIST) returns 409 not the default 400', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md/sub.md', content: 'oops' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('creating a directory whose parent does not exist returns 404 not the default 400', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'nope/child', kind: 'dir' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('an unclassified fs failure (e.g. permission denied) returns 500 not a misleading 400', async () => {
    if (process.getuid && process.getuid() === 0) return // root ignores permission bits; skip
    const target = path.join(t.root, 'notes/a.md')
    await fs.chmod(target, 0o000)
    try {
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/file?path=notes%2Fa.md',
        headers: auth(),
      })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'internal error' })
    } finally {
      await fs.chmod(target, 0o644)
    }
  })
})

// Fix round 1 / Finding 2: GET /api/tree and GET /api/git/status used to call
// straight into vault/git without a try/catch, so a VaultError from either
// fell through to the global setErrorHandler in app.ts, which classifies
// *every* VaultError as 400 — a coarser, different mapping than sendVaultError
// gives every other route (e.g. the "unexpected fs failure" case above maps
// to 500 there). Same underlying failure, different status depending on which
// route hit it. This pins that GET /api/tree now goes through sendVaultError
// like the rest, using the same "unreadable vault root" failure mode as the
// GET /api/file case above so the two are directly comparable.
describe('GET /api/tree goes through sendVaultError unified mapping (regression: must not bypass the global 400 fallback)', () => {
  it('returns 500 when the vault root is unreadable, not the 400 that the global fallback would produce', async () => {
    if (process.getuid && process.getuid() === 0) return // root ignores permission bits; skip
    await fs.chmod(t.root, 0o000)
    try {
      const res = await t.app.inject({ method: 'GET', url: '/api/tree', headers: auth() })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'internal error' })
    } finally {
      await fs.chmod(t.root, 0o755)
    }
  })
})

// Fix round 1 / Finding 1: PUT /api/file's read-then-write check for
// baseMtimeMs used to be two independent awaits with a gap between them.
// Two concurrent requests for the same path, both carrying a baseMtimeMs that
// matches disk at the moment they each check, could both pass the check
// before either had written — the second write would silently clobber the
// first with no 409 ever raised, defeating the whole point of the lock. The
// fix serializes the check-and-write per resolved path via an in-process
// promise chain (see withPathLock in routes/files.ts). These two tests pin
// that (a) same-path requests are now strictly ordered so exactly one wins
// and the loser is told about it, and (b) different-path requests are NOT
// serialized against each other — the lock is per-key, not global.
describe('PUT /api/file concurrent writes to the same path (in-process race)', () => {
  it('when two concurrent requests carry the same baseMtimeMs, exactly one succeeds and the other gets 409; disk content matches the winner', async () => {
    const before = await t.app.inject({
      method: 'GET',
      url: '/api/file?path=notes%2Fa.md',
      headers: auth(),
    })
    const baseMtimeMs = before.json().mtimeMs as number

    // Widening the race window on purpose: measured empirically on this
    // machine's filesystem that two back-to-back fs.writeFile calls can
    // produce mtimeMs deltas under 1ms (as low as ~0.2ms), which is narrower
    // than the API's own 1ms mtime tolerance. Without slowing writes down,
    // the second (correctly serialized) request could still read a
    // post-write mtime indistinguishable from the pre-write one purely due
    // to clock granularity, and this test would flake on whether it observes
    // a 409 — a filesystem-timing artifact unrelated to what's being tested
    // here (that in-process interleaving no longer happens at all once the
    // lock serializes the two requests). Adding a few ms of delay to the
    // underlying fs.writeFile call for the duration of this test only
    // guarantees the mtimes genuinely diverge past the tolerance, making the
    // assertion deterministic instead of a coin flip on write speed.
    const originalWriteFile = fs.writeFile
    const spy = vi
      .spyOn(fs, 'writeFile')
      .mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return (originalWriteFile as (...a: typeof args) => Promise<void>)(...args)
      })

    try {
      const [resA, resB] = await Promise.all([
        t.app.inject({
          method: 'PUT',
          url: '/api/file',
          headers: auth(),
          payload: { path: 'notes/a.md', content: 'from A\n', baseMtimeMs },
        }),
        t.app.inject({
          method: 'PUT',
          url: '/api/file',
          headers: auth(),
          payload: { path: 'notes/a.md', content: 'from B\n', baseMtimeMs },
        }),
      ])

      const statuses = [resA.statusCode, resB.statusCode].sort()
      expect(statuses).toEqual([200, 409])

      const winnerIsA = resA.statusCode === 200
      const winnerContent = winnerIsA ? 'from A\n' : 'from B\n'
      const loserRes = winnerIsA ? resB : resA

      expect(loserRes.json().disk.content).toBe(winnerContent)
      expect(await fs.readFile(path.join(t.root, 'notes/a.md'), 'utf8')).toBe(winnerContent)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('PUT /api/file concurrent writes to different paths (lock must not be global)', () => {
  it('two concurrent writes to different paths both succeed', async () => {
    const [resA, resB] = await Promise.all([
      t.app.inject({
        method: 'PUT',
        url: '/api/file',
        headers: auth(),
        payload: { path: 'notes/a.md', content: 'A\n' },
      }),
      t.app.inject({
        method: 'PUT',
        url: '/api/file',
        headers: auth(),
        payload: { path: 'notes/other.md', content: 'B\n' },
      }),
    ])

    expect(resA.statusCode).toBe(200)
    expect(resB.statusCode).toBe(200)
    expect(await fs.readFile(path.join(t.root, 'notes/a.md'), 'utf8')).toBe('A\n')
    expect(await fs.readFile(path.join(t.root, 'notes/other.md'), 'utf8')).toBe('B\n')
  })
})

describe('per-note history routes', () => {
  const write = async (rel: string, content: string) => {
    await fs.writeFile(path.join(t.root, rel), content)
  }
  const commit = async (message: string) => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/git/commit', headers: auth(), payload: { message },
    })
    expect(res.statusCode).toBe(200)
  }

  it('GET /api/git/log returns only the commits that touched the note', async () => {
    await write('notes/a.md', '# a\nsecond line\n')
    await commit('autosave: notes/a.md')
    await fs.writeFile(path.join(t.root, 'other.md'), 'unrelated\n')
    await commit('autosave: other.md')

    const res = await t.app.inject({ method: 'GET', url: '/api/git/log?path=notes%2Fa.md', headers: auth() })
    expect(res.statusCode).toBe(200)
    const { commits } = res.json()
    expect(commits.map((c: { message: string }) => c.message)).toEqual(['autosave: notes/a.md', 'initial'])
    expect(commits[0]).toMatchObject({ added: 1, removed: 0 })
    expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('GET /api/git/diff collapses a range into one diff for that note', async () => {
    await write('notes/a.md', '# a\nstep one\n')
    await commit('autosave 1')
    await write('notes/a.md', '# a\nstep two\n')
    await commit('autosave 2')

    const log = (await t.app.inject({ method: 'GET', url: '/api/git/log?path=notes%2Fa.md', headers: auth() })).json()
    const from = log.commits[log.commits.length - 1].sha
    const to = log.commits[0].sha
    const res = await t.app.inject({
      method: 'GET', url: `/api/git/diff?path=notes%2Fa.md&from=${from}&to=${to}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().diff).toContain('+step two')
    expect(res.json().diff).not.toContain('+step one')
  })

  it('GET /api/git/file-at returns the old content without touching the working tree', async () => {
    await write('notes/a.md', '# a\nrewritten\n')
    await commit('autosave: notes/a.md')
    const log = (await t.app.inject({ method: 'GET', url: '/api/git/log?path=notes%2Fa.md', headers: auth() })).json()
    const first = log.commits[log.commits.length - 1].sha

    const res = await t.app.inject({
      method: 'GET', url: `/api/git/file-at?path=notes%2Fa.md&sha=${first}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().content).toBe('# a\n')
    expect(await fs.readFile(path.join(t.root, 'notes', 'a.md'), 'utf8')).toBe('# a\nrewritten\n')
  })

  // These values reach a git command line, so neither the path nor the sha may go unchecked.
  it('rejects traversal paths and anything that is not a sha', async () => {
    const cases = [
      '/api/git/log?path=..%2F..%2Fetc%2Fpasswd',
      '/api/git/diff?path=notes%2Fa.md&to=HEAD',
      '/api/git/diff?path=notes%2Fa.md&to=abc123;rm%20-rf%20%2F',
      '/api/git/file-at?path=notes%2Fa.md&sha=--upload-pack%3Dtouch',
      '/api/git/file-at?path=%2Fetc%2Fpasswd&sha=abcdef1',
    ]
    for (const url of cases) {
      const res = await t.app.inject({ method: 'GET', url, headers: auth() })
      expect(res.statusCode, url).toBe(400)
    }
  })

  it('requires a session', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/git/log?path=notes%2Fa.md' })
    expect(res.statusCode).toBe(401)
  })
})

/**
 * Pictures.
 *
 * The name is the hash of the bytes, which is what makes two of these assertions possible at once:
 * the same picture pasted twice is one file, and a name can be served `immutable` because it can
 * never come to mean anything else.
 */
describe('/api/asset', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')

  it('stores a picture and names it after its own bytes', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/asset', headers: auth(), payload: { bytes: png, ext: 'png' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().path).toMatch(/^assets\/[a-f0-9]+\.png$/)

    const again = await t.app.inject({
      method: 'POST', url: '/api/asset', headers: auth(), payload: { bytes: png, ext: 'png' },
    })
    expect(again.json().path).toBe(res.json().path)
  })

  it('serves it back as a picture, cached for ever and never by a proxy', async () => {
    const { path: stored } = (await t.app.inject({
      method: 'POST', url: '/api/asset', headers: auth(), payload: { bytes: png, ext: 'png' },
    })).json()

    const res = await t.app.inject({
      method: 'GET', url: `/api/asset?path=${encodeURIComponent(stored)}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    // `private`, because a vault is behind one shared password: `public` would let every proxy in
    // between keep a copy of something that needed a cookie.
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.rawPayload.equals(Buffer.from(png, 'base64'))).toBe(true)
  })

  it('serves nothing from outside the assets directory', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/api/asset?path=notes/a.md', headers: auth(),
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a kind of file that is not a picture', async () => {
    const bad = await t.app.inject({
      method: 'POST', url: '/api/asset', headers: auth(), payload: { bytes: png, ext: 'svg' },
    })
    expect(bad.statusCode).toBe(400)
    const read = await t.app.inject({
      method: 'GET', url: '/api/asset?path=assets/x.svg', headers: auth(),
    })
    expect(read.statusCode).toBe(400)
  })

  it('needs a session, like everything else that touches the vault', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/asset?path=assets/x.png' })
    expect(res.statusCode).toBe(401)
  })
})
