import { useEffect, useState } from 'preact/hooks'
import { App } from '../App.js'
import { useBackend } from '../api/index.js'
import { createGitHubBackend } from '../api/github/backend.js'
import { GitHubSignIn } from './GitHubSignIn.js'
import { rebaseOpenDocument } from '../state/document.js'
import {
  chosenRepo,
  restoreSession,
  session,
  useIdentity,
  type IdentityProvider,
  type Repository,
} from './identity.js'
import { RepoPicker } from './RepoPicker.js'

/**
 * The app, when the notes live in someone's own GitHub repository.
 *
 * Three states before the editor — signed out, nothing installed, and choosing — and they are
 * states rather than steps: a reload lands in whichever one is still true. The provider is a
 * parameter so that development can hand in a stand-in without this file knowing.
 */
export function GitHubRoot({ identity }: { identity: IdentityProvider }) {
  const [ready, setReady] = useState(false)

  // Installed during render, not in the effect below.
  //
  // Preact runs a child's effects before its parent's, and this component now draws the whole
  // application on its first render — so App's mount effect ran *before* this one did. Anything
  // asking `hasIdentity()` at that moment got false: `loadShares` does, and it fails silently by
  // design, so every note's menu said `Share…` for ever while the server knew perfectly well the
  // note was shared. Pressing it returned the original link, which is what gave the bug away.
  //
  // A plain idempotent assignment to a module-level variable, so doing it in render is safe.
  useIdentity(identity)

  useEffect(() => {
    void restoreSession().then(() => { setReady(true) })
  }, [])

  // Before the network has answered, a repository this browser has used before is enough to draw
  // the whole application. Restoring costs three round trips and used to draw nothing for all of
  // them; the tree arrives into a shell that is already there, which is what the rest of the app
  // does with a note. If the session turns out to be gone, the effect above corrects it — a
  // moment of the real interface beats two seconds of white.
  if (!ready) {
    return chosenRepo.value === null ? null : <RepoApp repo={chosenRepo.value} identity={identity} />
  }
  if (session.value === null) return <GitHubSignIn />

  const repo = chosenRepo.value
  if (repo === null) return <RepoPicker />

  return <RepoApp repo={repo} identity={identity} />
}

/**
 * The app, once there is a repository for it to be about.
 *
 * The backend is installed before the first render rather than in an effect, because `App` reads
 * the tree on mount and would otherwise ask this server for a vault it does not have.
 */
function RepoApp({ repo, identity }: { repo: Repository; identity: IdentityProvider }) {
  const [installed, setInstalled] = useState(false)

  if (!installed) {
    useBackend(createGitHubBackend({
      owner: repo.owner,
      repo: repo.name,
      ref: repo.defaultBranch,
      // The provider itself, not the module-level one: this component renders before the effect
      // that installs that has run, and reaching for it then would throw.
      //
      // Asked for again on every request: an access token is good for eight hours and a tab may
      // outlive one.
      token: () => identity.token(),
      // A token can be replaced from another device; see `IdentityProvider.renew`.
      renew: () => identity.renew(),
      // Every commit moves the base the open document is measured against — the timer's as much as
      // the button's. See `rebaseOpenDocument`.
      onCommitted: () => { void rebaseOpenDocument() },
    }))
    setInstalled(true)
    return null
  }

  return <App />
}
