import { GitHubRest } from '../api/github/rest.js'
import type { IdentityProvider, Repository, Session } from './identity.js'

/** Renew a minute early, so a request never leaves with a token that expires mid-flight. */
const EARLY_MS = 60_000

interface Installation { id: number }
interface ApiRepository {
  name: string
  default_branch: string
  owner: { login: string }
}

/**
 * The real thing: signing in through this server's three routes, and reading GitHub directly.
 *
 * The access token lives here, **in a closure and nowhere else** — not in `localStorage`, not in a
 * signal, not on `window`. A reload loses it and asks for another, which is the point: the only
 * durable credential is the refresh cookie, which script cannot read. See `src/server/github-auth.ts`
 * for the other half.
 */
export function githubIdentity(deps: { fetch?: typeof globalThis.fetch } = {}): IdentityProvider {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
  let access: { token: string; expiresAt: number } | null = null
  /**
   * A refresh already on its way, which every other caller waits for instead of starting another.
   *
   * **GitHub rotates the refresh token on every use.** Two refreshes in flight at once means the
   * second presents one that the first has already spent: GitHub refuses it, and this server —
   * correctly, for a genuinely spent token — clears the cookie. So a concurrent refresh does not
   * merely fail, it signs the user out.
   *
   * That is not hypothetical. The app draws itself before the session has finished restoring, so
   * the file tree asks for a token while `restoreSession` is still asking for one, and the tree
   * simply never arrived.
   */
  let refreshing: Promise<string> | null = null

  /**
   * @param force Throw away the held token first.
   *
   * A token can stop working before the expiry it was given: signing in on a second device
   * replaces it, and every call from the first is then answered `Bad credentials`. Nothing here
   * can see that — the clock says the token is good — so the 401 is the signal, and this is what
   * {@link GitHubRest} calls when it gets one.
   */
  async function fresh(force = false): Promise<string> {
    if (force) access = null
    if (access !== null && Date.now() < access.expiresAt - EARLY_MS) return access.token
    if (refreshing !== null) return refreshing

    refreshing = (async () => {
      const res = await doFetch('/api/github/token', { method: 'POST' })
      if (!res.ok) {
        access = null
        throw new NotSignedIn()
      }
      const body = await res.json() as { accessToken: string; expiresIn: number }
      access = { token: body.accessToken, expiresAt: Date.now() + body.expiresIn * 1000 }
      return body.accessToken
    })()

    try {
      return await refreshing
    } finally {
      refreshing = null
    }
  }

  const rest = new GitHubRest({
    token: () => fresh(),
    renew: () => fresh(true),
    fetch: doFetch,
  })

  return {
    begin(returnTo?: string): void {
      // A full navigation rather than a popup: popups are blocked, and this way the return trip
      // is an ordinary page load with a cookie already set.
      location.href = returnTo === undefined
        ? '/api/github/start'
        : `/api/github/start?return=${encodeURIComponent(returnTo)}`
    },

    async restore(): Promise<Session | null> {
      try {
        await fresh()
      } catch (err) {
        if (err instanceof NotSignedIn) return null
        throw err
      }

      // Independent questions, asked at the same time. Restoring a session is the first thing that
      // happens on every load and nothing renders until it answers, so each round trip it takes is
      // a round trip of blank screen — and these are to api.github.com, which from some of the
      // world is a few hundred milliseconds each.
      const [user, { installations }] = await Promise.all([
        rest.request<{ login: string }>('/user'),
        rest.request<{ installations: Installation[] }>('/user/installations'),
      ])

      // Usually one. More than one means the app was installed on several accounts or orgs, and
      // all of their repositories belong in the same list — the user picked every one of them.
      // Also in parallel: one installation's repositories tell you nothing about another's.
      const lists = await Promise.all(installations.map((installation) =>
        rest.request<{ repositories: ApiRepository[] }>(
          `/user/installations/${installation.id}/repositories?per_page=100`,
        )))

      const repositories: Repository[] = []
      for (const { repositories: repos } of lists) {
        for (const repo of repos) {
          repositories.push({
            owner: repo.owner.login,
            name: repo.name,
            defaultBranch: repo.default_branch,
          })
        }
      }
      repositories.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`))

      return { login: user.login, repositories }
    },

    token: () => fresh(),
    renew: () => fresh(true),

    async signOut(): Promise<void> {
      access = null
      await doFetch('/api/github/signout', { method: 'POST' })
    },
  }
}

/** Not an error to report: it is what having no session looks like. */
class NotSignedIn extends Error {
  constructor() {
    super('not signed in')
    this.name = 'NotSignedIn'
  }
}
