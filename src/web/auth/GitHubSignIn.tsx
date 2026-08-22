import { AuthCard } from './AuthCard.js'
import { identityError, identityProvider } from './identity.js'

/**
 * The whole of signing up.
 *
 * There is no form here because there is no account here: no email field, no password rules, no
 * confirmation mail, no forgotten-password flow. Those are GitHub's, and not having to build them
 * is the cheapest part of this route.
 *
 * The lines under the button are the screen's content rather than its fine print. They are the
 * reason someone would press it, and **each one is a claim that has to be true of the build**.
 *
 * The one about the session is there because the alternative — keeping the refresh token in the
 * browser, so that nothing of the user's is held here — is the less safe design, and a neater
 * sentence is not a reason to choose it. Saying the true thing plainly costs one line.
 */
export function GitHubSignIn() {
  return (
    <AuthCard step="notes, in your own repo">
      <p class="ink-auth-say">A markdown editor for a repository you already have.</p>

      <button type="button" class="ink-auth-go" onClick={() => { identityProvider().begin() }}>
        <GitHubMark />
        Continue with GitHub
      </button>

      <ul class="ink-auth-claims">
        <li>You pick which repository, on GitHub's screen.</li>
        <li>Read and write files in it. Nothing else.</li>
        {/* The clause is not a hedge. Sharing keeps a copy of one note on this server, and a
            promise about what happens without your say-so has to gain its exception before the
            feature ships rather than after somebody notices. */}
        <li>Your notes go from your browser to GitHub, never through this server — except a note you choose to share.</li>
        {/* The session claim and the revocation link were two items saying one thing, and the
            longer of them was the least urgent. One line, and the link is inside it. */}
        <li>
          Your GitHub session does — revoke it here or in your{' '}
          <a href="https://github.com/settings/installations" target="_blank" rel="noreferrer">
            GitHub settings
          </a>.
        </li>
      </ul>

      {identityError.value && <p class="ink-auth-error" role="alert">{identityError.value}</p>}
    </AuthCard>
  )
}

/** Drawn here for the same reason every other icon in this app is: nothing loads from a CDN. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}
