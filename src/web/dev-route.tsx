import { useBackend } from './api/index.js'
import { createGitHubBackend } from './api/github/backend.js'
import { rebaseOpenDocument } from './state/document.js'
import { fakeIdentity } from './auth/fake.js'
import { GitHubRoot } from './auth/GitHubRoot.js'
import type { Repository } from './auth/identity.js'

/**
 * Two doors that exist only while developing, and never in a built app.
 *
 * Both sit behind `import.meta.env.DEV` at their single call site, which Vite replaces with
 * `false` at build time — an e2e test greps the shipped bundles for this file's storage key to
 * keep that true. The real sign-in needs neither of them: it is chosen by the server saying so.
 *
 * In the dev server's own devtools:
 *
 * ```js
 * // The screens, with a stand-in for GitHub. Needs no server configuration.
 * localStorage.setItem('inkstone.dev.github', JSON.stringify({
 *   mode: 'identity',
 *   login: 'you',
 *   token: '<a fine-grained PAT, contents: read and write>',
 *   repositories: [{ owner: 'you', name: 'notes', defaultBranch: 'main' }],
 * }))
 *
 * // Straight into one repository, no screens — the shorter path when the backend is the
 * // thing being worked on.
 * localStorage.setItem('inkstone.dev.github', JSON.stringify({
 *   owner: 'you', repo: 'notes', ref: 'main', token: '<a PAT>',
 * }))
 * ```
 *
 * Any token here is yours, goes in your browser, and never leaves this machine.
 */
export interface DevConfig {
  mode?: 'identity' | 'direct'
  owner?: string
  repo?: string
  ref?: string
  token?: string
  login?: string
  repositories?: Repository[]
  /** Start the stand-in already signed in, which is what a screenshot of a later screen needs. */
  signedIn?: boolean
}

export function readDevConfig(): DevConfig | null {
  let raw: string | null = null
  try { raw = localStorage.getItem('inkstone.dev.github') } catch { return null }
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as DevConfig
    return typeof parsed.token === 'string' && parsed.token !== '' ? parsed : null
  } catch {
    return null
  }
}

/** Opens one repository with no sign-in, for when the backend is what is being worked on. */
export function installDirectBackend(config: DevConfig): boolean {
  if (!config.owner || !config.repo || !config.token) return false
  const token = config.token
  useBackend(createGitHubBackend({
    owner: config.owner,
    repo: config.repo,
    ref: config.ref ?? 'main',
    token: () => token,
    onCommitted: () => { void rebaseOpenDocument() },
  }))
  return true
}

/** The real screens, in front of a GitHub that is not there. */
export function DevGitHubRoute({ config }: { config: DevConfig }) {
  return (
    <GitHubRoot
      identity={fakeIdentity({
        login: config.login ?? 'you',
        repositories: config.repositories ?? [],
        token: config.token ?? '',
        signedIn: config.signedIn,
      })}
    />
  )
}
