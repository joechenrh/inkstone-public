import { signal } from '@preact/signals'

/** One repository the user has let the app into, as GitHub lists it. */
export interface Repository {
  owner: string
  name: string
  defaultBranch: string
}

export interface Session {
  /** The GitHub login, shown so it is obvious whose repositories these are. */
  login: string
  repositories: Repository[]
}

/**
 * Signing in, and being told which repositories may be touched.
 *
 * An interface rather than an implementation because the real one cannot be built yet: it needs a
 * registered GitHub App, and the code-for-token exchange needs the App's private key, which is the
 * one thing that cannot live in a browser. Until that exists, `fake.ts` stands in — the screens,
 * the wiring and the tests are all real, and only the provider is not.
 *
 * **Open, and deliberately not decided here:** whether the server keeps the user's refresh token
 * in a session, or hands it to the browser and stays stateless. The first is ordinary; the second
 * is what keeps the sentence *"there is no token of yours on my server"* true. It is a question
 * about the real provider, and it does not change this interface.
 */
export interface IdentityProvider {
  /**
   * Leaves for GitHub's own screen. Never resolves — the page is going away.
   *
   * `returnTo` is a path on this origin to land on afterwards, for a sign-in that started
   * somewhere other than the front door — a reader pressing Save on a shared note.
   */
  begin(returnTo?: string): void
  /** On load: an existing session, or null when there is none. */
  restore(): Promise<Session | null>
  /** A token good right now. Called before every request, because these expire. */
  token(): Promise<string>
  signOut(): Promise<void>
}

export const session = signal<Session | null>(null)
export const identityError = signal<string | null>(null)

/**
 * Where to send someone whose installation covers nothing, from `/api/github/app`.
 *
 * Null when this server was not told the App's slug, in which case the empty state falls back to
 * GitHub's own installations page — worse, because it lists what you have rather than offering
 * the one you want.
 */
export const installUrl = signal<string | null>(null)

const CHOICE_KEY = 'inkstone.repo'

/**
 * The repository remembered from last time, read before anything is asked of the network.
 *
 * Restoring a session costs three round trips — one through this server to `github.com` for a
 * token, then two to `api.github.com` — and until it answered the app drew `null`, which is a
 * blank page for about two seconds on every load. A repository this browser has used before is
 * enough to draw the whole application immediately and let the tree arrive into it.
 *
 * The default branch is stored with it, which the older `owner/name` form did not carry — that
 * form is still read, and simply waits for the network as it always did.
 */
function remembered(): Repository | null {
  let raw: string | null = null
  try { raw = localStorage.getItem(CHOICE_KEY) } catch { return null }
  if (raw === null || !raw.startsWith('{')) return null
  try {
    const saved = JSON.parse(raw) as Repository
    return typeof saved.owner === 'string' && typeof saved.name === 'string'
      && typeof saved.defaultBranch === 'string'
      ? saved
      : null
  } catch {
    return null
  }
}

/** Which repository is open, remembered so a reload does not ask again — nor wait to draw. */
export const chosenRepo = signal<Repository | null>(remembered())

let provider: IdentityProvider | null = null

export function useIdentity(next: IdentityProvider): void {
  provider = next
}

/** Whether anything is signing in with GitHub, which decides what "log out" has to mean. */
export function hasIdentity(): boolean {
  return provider !== null
}

/** Send the user back to the list without signing them out. */
export function forgetChosenRepo(): void {
  chosenRepo.value = null
  try { localStorage.removeItem(CHOICE_KEY) } catch { /* nothing to clean up */ }
}

export function identityProvider(): IdentityProvider {
  if (provider === null) throw new Error('no identity provider installed')
  return provider
}

export async function restoreSession(): Promise<void> {
  identityError.value = null
  try {
    const res = await fetch('/api/github/app')
    if (res.ok) installUrl.value = (await res.json() as { installUrl: string | null }).installUrl
  } catch { /* the link is a convenience; failing to fetch it must not block signing in */ }

  try {
    const restored = await identityProvider().restore()
    session.value = restored
    chosenRepo.value = restored === null ? null : readChoice(restored.repositories)
  } catch (err) {
    identityError.value = err instanceof Error ? err.message : 'Could not reach GitHub'
  }
}

export function chooseRepo(repo: Repository): void {
  chosenRepo.value = repo
  try {
    // The whole repository, not just its name: the backend needs the default branch, and reading
    // it back without a round trip is what lets the app render before the network answers.
    localStorage.setItem(CHOICE_KEY, JSON.stringify(repo))
  } catch { /* a forgotten choice costs one tap next time, and is not worth failing over */ }
}

export async function signOut(): Promise<void> {
  await identityProvider().signOut()
  session.value = null
  chosenRepo.value = null
  try { localStorage.removeItem(CHOICE_KEY) } catch { /* nothing to clean up */ }
}

/**
 * The remembered choice, but only if it is still one of the repositories on offer — an
 * installation the user has since narrowed must not leave the app pointed at a repo it can no
 * longer read.
 */
function readChoice(available: Repository[]): Repository | null {
  const saved = remembered()
  if (saved !== null) {
    return available.find((r) => r.owner === saved.owner && r.name === saved.name) ?? null
  }

  // An older browser wrote `owner/name`, which cannot be read without the network because it does
  // not carry the default branch. Upgrade it in place the first time it is validated: otherwise
  // anyone who chose their repository before this change would keep the blank page for ever,
  // having no reason ever to open the picker again.
  const legacy = readLegacyChoice(available)
  if (legacy !== null) chooseRepo(legacy)
  return legacy
}

/** The `owner/name` form written before the default branch was stored beside it. */
function readLegacyChoice(available: Repository[]): Repository | null {
  let saved: string | null = null
  try { saved = localStorage.getItem(CHOICE_KEY) } catch { return null }
  if (saved === null) return null
  return available.find((r) => `${r.owner}/${r.name}` === saved) ?? null
}
