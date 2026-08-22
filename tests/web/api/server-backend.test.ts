import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendError, ConflictError } from '../../../src/web/api/backend.js'
import { auth, serverBackend } from '../../../src/web/api/server-backend.js'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('readFile', () => {
  it('URL-encodes the path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: 'a b.md', content: 'x', mtimeMs: 1 }))
    await serverBackend.readFile('notes/a b.md')
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/file?path=notes%2Fa%20b.md')
  })

  it('reports the mtime as both the rev and the modified time', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: 'a.md', content: 'x', mtimeMs: 1700 }))
    await expect(serverBackend.readFile('a.md')).resolves.toEqual({
      path: 'a.md',
      content: 'x',
      rev: '1700',
      modifiedAt: 1700,
    })
  })

  it('throws BackendError with a status code on 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    await expect(serverBackend.readFile('nope.md')).rejects.toMatchObject({ status: 404 })
  })
})

describe('writeFile', () => {
  it('sends the rev back as the numeric baseMtimeMs the server expects', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mtimeMs: 2 }))
    await serverBackend.writeFile('a.md', 'body', '1')
    const init = fetchMock.mock.calls[0]![1]
    expect(JSON.parse(init.body)).toEqual({ path: 'a.md', content: 'body', baseMtimeMs: 1 })
  })

  it('omits the field when no base rev is passed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mtimeMs: 2 }))
    await serverBackend.writeFile('a.md', 'body')
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ path: 'a.md', content: 'body' })
  })

  it('throws ConflictError carrying their whole version on 409', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ error: 'file changed on disk', disk: { content: 'theirs', mtimeMs: 9 } }, 409),
      ),
    )
    await expect(serverBackend.writeFile('a.md', 'mine', '1')).rejects.toBeInstanceOf(ConflictError)
    // The path is not in the 409 body — the backend knows it because it sent the write.
    await expect(serverBackend.writeFile('a.md', 'mine', '1')).rejects.toMatchObject({
      theirs: { path: 'a.md', content: 'theirs', rev: '9', modifiedAt: 9 },
    })
  })
})

describe('isSameRev', () => {
  it('tolerates a one-millisecond difference, which is a write echoing back', () => {
    expect(serverBackend.isSameRev('1000', '1001')).toBe(true)
    expect(serverBackend.isSameRev('1000', '1000')).toBe(true)
  })

  it('separates revs further apart than that', () => {
    expect(serverBackend.isSameRev('1000', '1002')).toBe(false)
  })

  it('never matches an absent rev, so a file with no baseline is always re-read', () => {
    expect(serverBackend.isSameRev(null, '1000')).toBe(false)
    expect(serverBackend.isSameRev('1000', null)).toBe(false)
    expect(serverBackend.isSameRev(null, null)).toBe(false)
  })
})

describe('auth.signIn', () => {
  it('throws 401 on a wrong password', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    await expect(auth.signIn('wrong')).rejects.toBeInstanceOf(BackendError)
  })

  it('does not throw on success', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(auth.signIn('right')).resolves.toBeUndefined()
  })
})

describe('204 response', () => {
  it('remove does not try to parse an empty body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(serverBackend.remove('a.md')).resolves.toBeUndefined()
  })
})

describe('info', () => {
  it('labels the vault with its root path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ root: '/home/user/vault' }))
    await expect(serverBackend.info()).resolves.toEqual({ label: '/home/user/vault' })
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/vault/info')
  })
})

describe('auth.signOut', () => {
  it('calls POST /api/logout', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(auth.signOut()).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' })
  })
})
