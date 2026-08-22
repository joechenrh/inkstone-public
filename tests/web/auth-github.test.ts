import { describe, expect, it, vi } from 'vitest'
import { githubIdentity } from '../../src/web/auth/github.js'

/** This server's token route, then api.github.com — two hosts, answered by one stub. */
function stub(routes: Record<string, unknown>, opts: { tokenStatus?: number } = {}) {
  const calls: string[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)

    if (url === '/api/github/token') {
      const status = opts.tokenStatus ?? 200
      return status === 200
        ? new Response(JSON.stringify({ accessToken: 'gho_access', expiresIn: 28800 }), {
          status, headers: { 'content-type': 'application/json' },
        })
        : new Response(JSON.stringify({ error: 'not signed in' }), {
          status, headers: { 'content-type': 'application/json' },
        })
    }

    const path = url.replace('https://api.github.com', '')
    const body = routes[path]
    return new Response(JSON.stringify(body ?? { message: `no route ${path}` }), {
      status: body === undefined ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

const SIGNED_IN = {
  '/user': { login: 'octocat' },
  '/user/installations': { installations: [{ id: 42 }] },
  '/user/installations/42/repositories?per_page=100': {
    repositories: [
      { name: 'notes', default_branch: 'main', owner: { login: 'octocat' } },
      { name: 'journal', default_branch: 'trunk', owner: { login: 'octocat' } },
    ],
  },
}

describe('restore', () => {
  it('is null when the server has no session, which is not an error', async () => {
    const { fetch, calls } = stub({}, { tokenStatus: 401 })
    await expect(githubIdentity({ fetch }).restore()).resolves.toBeNull()
    // Nothing is asked of GitHub without a token to ask with.
    expect(calls.filter((c) => c.includes('api.github.com'))).toEqual([])
  })

  it('reads the login and every repository the installation covers', async () => {
    const { fetch } = stub(SIGNED_IN)
    await expect(githubIdentity({ fetch }).restore()).resolves.toEqual({
      login: 'octocat',
      repositories: [
        { owner: 'octocat', name: 'journal', defaultBranch: 'trunk' },
        { owner: 'octocat', name: 'notes', defaultBranch: 'main' },
      ],
    })
  })

  it('gathers repositories from more than one installation', async () => {
    const { fetch } = stub({
      '/user': { login: 'octocat' },
      '/user/installations': { installations: [{ id: 1 }, { id: 2 }] },
      '/user/installations/1/repositories?per_page=100': {
        repositories: [{ name: 'notes', default_branch: 'main', owner: { login: 'octocat' } }],
      },
      '/user/installations/2/repositories?per_page=100': {
        repositories: [{ name: 'handbook', default_branch: 'main', owner: { login: 'some-org' } }],
      },
    })
    const session = await githubIdentity({ fetch }).restore()
    expect(session!.repositories.map((r) => `${r.owner}/${r.name}`))
      .toEqual(['octocat/notes', 'some-org/handbook'])
  })
})

describe('the access token', () => {
  it('is asked for once and reused while it is good', async () => {
    const { fetch, calls } = stub(SIGNED_IN)
    const identity = githubIdentity({ fetch })
    await identity.restore()
    await identity.token()
    await identity.token()
    expect(calls.filter((c) => c === 'POST /api/github/token')).toHaveLength(1)
  })

  it('is renewed once it is close to expiring', async () => {
    const { fetch, calls } = stub(SIGNED_IN)
    const identity = githubIdentity({ fetch })
    await identity.token()
    // Eight hours on, which is past the point where a request could outlive the token.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 60 * 60 * 1000)
    await identity.token()
    expect(calls.filter((c) => c === 'POST /api/github/token')).toHaveLength(2)
    vi.restoreAllMocks()
  })

  it('never reaches storage — a reload is meant to lose it', async () => {
    localStorage.clear()
    const { fetch } = stub(SIGNED_IN)
    const identity = githubIdentity({ fetch })
    await identity.restore()
    await identity.token()
    const stored = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? '').join(' ')
    expect(stored).not.toContain('gho_access')
    expect(JSON.stringify(sessionStorage)).not.toContain('gho_access')
  })

  it('is dropped on sign-out, along with the server\'s copy', async () => {
    const { fetch, calls } = stub(SIGNED_IN)
    const identity = githubIdentity({ fetch })
    await identity.token()
    await identity.signOut()
    await identity.token()
    expect(calls).toContain('POST /api/github/signout')
    expect(calls.filter((c) => c === 'POST /api/github/token')).toHaveLength(2)
  })
})

describe('how many round trips a restore costs', () => {
  /**
   * Restoring is the first thing that happens on every load and nothing renders until it answers,
   * so each round trip it takes is a round trip of blank screen — and these go to api.github.com,
   * which from some of the world is a few hundred milliseconds each. Independent questions must
   * therefore be asked at the same time, and this counts the depth rather than the calls.
   */
  it('asks independent questions at the same time', async () => {
    const order: string[] = []
    let inFlight = 0
    let widest = 0

    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      inFlight += 1
      widest = Math.max(widest, inFlight)
      order.push(url)
      // A tick of latency, so anything awaited in sequence cannot overlap by accident.
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1

      if (url === '/api/github/token') {
        return Response.json({ accessToken: 'gho_access', expiresIn: 28800 })
      }
      const path = url.replace('https://api.github.com', '')
      if (path === '/user') return Response.json({ login: 'octocat' })
      if (path === '/user/installations') return Response.json({ installations: [{ id: 1 }, { id: 2 }] })
      return Response.json({ repositories: [{ name: 'n', default_branch: 'main', owner: { login: 'o' } }] })
    })

    const session = await githubIdentity({ fetch: fetch as unknown as typeof globalThis.fetch }).restore()
    expect(session?.repositories).toHaveLength(2)

    // The token, then /user beside /user/installations, then both repository lists together.
    expect(widest).toBeGreaterThan(1)
    expect(order.slice(1, 3).sort()).toEqual([
      'https://api.github.com/user',
      'https://api.github.com/user/installations',
    ])
  })
})

describe('refreshing the access token', () => {
  /**
   * GitHub rotates the refresh token on every use, so two refreshes at once means the second
   * presents one the first has already spent — GitHub refuses it and this server clears the
   * cookie. A concurrent refresh therefore does not merely fail, it signs the user out. The app
   * draws itself before the session has finished restoring, so this happens on an ordinary load.
   */
  it('asks once however many callers want a token at the same time', async () => {
    let calls = 0
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/github/token') {
        calls += 1
        await new Promise((r) => setTimeout(r, 20))
        return Response.json({ accessToken: 'gho_access', expiresIn: 28800 })
      }
      return Response.json({ login: 'octocat' })
    })

    const identity = githubIdentity({ fetch: fetch as unknown as typeof globalThis.fetch })
    const tokens = await Promise.all([identity.token(), identity.token(), identity.token()])

    expect(calls).toBe(1)
    expect(tokens).toEqual(['gho_access', 'gho_access', 'gho_access'])
  })

  it('starts a new one after the first has settled', async () => {
    let calls = 0
    const fetch = vi.fn(async () => {
      calls += 1
      // Already expired, so the cache cannot answer the second call.
      return Response.json({ accessToken: `gho_${calls}`, expiresIn: 0 })
    })

    const identity = githubIdentity({ fetch: fetch as unknown as typeof globalThis.fetch })
    expect(await identity.token()).toBe('gho_1')
    expect(await identity.token()).toBe('gho_2')
  })

  it('lets the next caller try again after a failure, rather than latching', async () => {
    let calls = 0
    const fetch = vi.fn(async () => {
      calls += 1
      return calls === 1
        ? new Response('{}', { status: 401 })
        : Response.json({ accessToken: 'gho_ok', expiresIn: 28800 })
    })

    const identity = githubIdentity({ fetch: fetch as unknown as typeof globalThis.fetch })
    await expect(identity.token()).rejects.toThrow()
    expect(await identity.token()).toBe('gho_ok')
  })
})
