import { describe, expect, it, vi } from 'vitest'
import { GitHubRest, RAW } from '../../../../src/web/api/github/rest.js'

function restWith(respond: (url: string, init: RequestInit) => Response, token = 'tok') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    respond(String(input), init ?? {}))
  return {
    fetchMock,
    rest: new GitHubRest({ token: () => token, fetch: fetchMock as unknown as typeof globalThis.fetch }),
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/**
 * A token that stopped working before it expired.
 *
 * Signing in on a second device replaces the first device's token, and nothing on this side can
 * tell: the expiry it was given has not passed. GitHub says `Bad credentials`, and until this the
 * reader saw those two words and had to reload the page.
 */
describe('a token refused before its time', () => {
  it('asks for a new one and sends the request again', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init!.headers as Record<string, string>).authorization ?? ''
      seen.push(auth)
      return auth === 'Bearer stale'
        ? json({ message: 'Bad credentials' }, 401)
        : json({ ok: true })
    })
    const rest = new GitHubRest({
      token: () => 'stale',
      renew: async () => 'fresh',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })

    expect(await rest.request('/user')).toEqual({ ok: true })
    expect(seen).toEqual(['Bearer stale', 'Bearer fresh'])
  })

  it('reports the refusal when the new one is refused too, and never tries a third time', async () => {
    const fetchMock = vi.fn(async () => json({ message: 'Bad credentials' }, 401))
    const rest = new GitHubRest({
      token: () => 'stale',
      renew: async () => 'fresh',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })

    await expect(rest.request('/user')).rejects.toThrow('Bad credentials')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 401 when there is no way to get a new token', async () => {
    const { rest, fetchMock } = restWith(() => json({ message: 'Bad credentials' }, 401))
    await expect(rest.request('/user')).rejects.toThrow('Bad credentials')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('requests', () => {
  it('carries the token, and asks again for it on every request', async () => {
    let issued = 0
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({}))
    const rest = new GitHubRest({
      token: () => `token-${++issued}`,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    // An installation token expires in an hour, so one captured at construction goes stale
    // mid-session. Each request reads it again.
    await rest.request('/a')
    await rest.request('/b')
    expect(issued).toBe(2)
    const headers = fetchMock.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).authorization)
    expect(headers).toEqual(['Bearer token-1', 'Bearer token-2'])
  })

  it('sends content-type only when there is a body, which is what forces the preflight', async () => {
    const { rest, fetchMock } = restWith(() => json({}))
    await rest.request('/a')
    await rest.request('/b', { method: 'POST', body: { x: 1 } })
    const [, first] = fetchMock.mock.calls[0]!
    const [, second] = fetchMock.mock.calls[1]!
    expect((first!.headers as Record<string, string>)['content-type']).toBeUndefined()
    expect((second!.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  it('returns text rather than JSON when a raw media type was asked for', async () => {
    const { rest } = restWith(() => new Response('# raw markdown', { status: 200 }))
    await expect(rest.request('/blob', { accept: RAW })).resolves.toBe('# raw markdown')
  })
})

describe('failures', () => {
  it('uses GitHub\'s own message', async () => {
    const { rest } = restWith(() => json({ message: 'Not Found' }, 404))
    await expect(rest.request('/nope')).rejects.toMatchObject({ message: 'Not Found', status: 404 })
  })

  it('names the rate limit and when it lifts, since that is the failure that fixes itself', async () => {
    const reset = Math.floor(Date.parse('2026-08-11T10:30:00Z') / 1000)
    const { rest } = restWith(() => json({ message: 'API rate limit exceeded' }, 403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(reset),
    }))
    await expect(rest.request('/a')).rejects.toThrow(/rate limit reached — it resets at/)
  })

  it('does not call an ordinary 403 a rate limit', async () => {
    const { rest } = restWith(() => json({ message: 'Resource not accessible by integration' }, 403, {
      'x-ratelimit-remaining': '4999',
    }))
    await expect(rest.request('/a')).rejects.toMatchObject({
      message: 'Resource not accessible by integration',
    })
  })

  it('reports an unreachable GitHub as one thing, because the browser will not say more', async () => {
    const rest = new GitHubRest({
      token: () => 'tok',
      // What a CORS refusal and a dead network both look like from script.
      fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof globalThis.fetch,
    })
    await expect(rest.request('/a')).rejects.toMatchObject({ message: 'Could not reach GitHub', status: 0 })
  })
})
