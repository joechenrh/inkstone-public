import { useLayoutEffect, useRef } from 'preact/hooks'
import { isPhone } from '../state/ui.js'
import { AuthCard } from './AuthCard.js'
import { chooseRepo, installUrl, session, type Repository } from './identity.js'

/**
 * Which repository, of the ones the user let the app into.
 *
 * Reached once. There is no filter, because the list is not a vault — it is however many
 * repositories were ticked on GitHub's own screen, and a search box over three rows is chrome
 * pretending to be a feature. If it ever stops fitting, the tree's search field is the answer.
 */
export function RepoPicker() {
  const repositories = session.value?.repositories ?? []
  const first = useRef<HTMLButtonElement>(null)

  // autoFocus does not work on anything mounted after load; the flag is spent by then.
  useLayoutEffect(() => { first.current?.focus() }, [])

  // Signing in and installing are two separate acts on GitHub's side, and a first-time user has
  // only done the first. Landing them on a sentence with no button was a dead end — which is a
  // bug, not a missing feature.
  if (repositories.length === 0) {
    return (
      <AuthCard step="one more step">
        <p class="ink-auth-say">
          You are signed in. Now choose which repository Inkstone may edit — on GitHub's screen,
          where you can also take it back.
        </p>
        <a
          class="ink-auth-go"
          href={installUrl.value ?? 'https://github.com/settings/installations'}
        >
          Choose a repository on GitHub&nbsp;→
        </a>
        <p class="ink-auth-foot">
          <span>Already chose one?</span>
          <a href="/">Reload</a>
        </p>
      </AuthCard>
    )
  }

  return (
    <AuthCard step="choose a repository">
      <p class="ink-auth-lead">Inkstone may edit these — you chose them on GitHub.</p>
      <ul class="ink-auth-list">
        {repositories.map((repo, i) => (
          <li key={`${repo.owner}/${repo.name}`}>
            <button
              type="button"
              ref={i === 0 ? first : undefined}
              class="ink-repo"
              onClick={() => { chooseRepo(repo) }}
            >
              <span class="ink-repo-owner">{repo.owner}/</span>
              <span class="ink-repo-name">{repo.name}</span>
              <span class="ink-repo-branch">{repo.defaultBranch}</span>
            </button>
          </li>
        ))}
      </ul>
      <p class="ink-auth-foot">
        <span>{session.value?.login}</span>
        {/* Leaving for a settings page is awkward on a phone, and Settings already has the link. */}
        {!isPhone.value && (
          <a href="https://github.com/settings/installations" target="_blank" rel="noreferrer">
            Change on GitHub ↗
          </a>
        )}
      </p>
    </AuthCard>
  )
}

export type { Repository }
