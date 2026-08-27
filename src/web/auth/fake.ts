import type { IdentityProvider, Session } from './identity.js'

/**
 * A stand-in for the GitHub App, so the screens in front of it can be built and tested before the
 * App exists.
 *
 * It signs in instantly, offers whatever repositories it was given, and hands out a token the
 * caller supplies. It is only ever reached from the development door in `api/index.ts`, and it
 * short-circuits the one thing it cannot fake: leaving for github.com and coming back.
 */
export function fakeIdentity(config: {
  login: string
  repositories: Session['repositories']
  token: string
  /** Starts signed out unless a previous `begin()` in this tab said otherwise. */
  signedIn?: boolean
}): IdentityProvider {
  let signedIn = config.signedIn ?? false
  return {
    begin(): void { signedIn = true },
    async restore(): Promise<Session | null> {
      return signedIn ? { login: config.login, repositories: config.repositories } : null
    },
    async token(): Promise<string> { return config.token },
    async renew(): Promise<string> { return config.token },
    async signOut(): Promise<void> { signedIn = false },
  }
}
