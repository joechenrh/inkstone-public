import { IconCommit, IconGitBranch, IconPushArrow } from '../components/icons.js'
import { gitBusy, gitError, gitStatus, pushVault } from '../state/git.js'
import { commitLoading, openCommit } from '../state/commit.js'

/**
 * Vault-level git state and actions. These describe the vault — the same thing the sidebar
 * itself shows — so they live at the bottom of the sidebar rather than in the status bar,
 * which is scoped to the open document.
 */
export function GitFooter() {

  const status = gitStatus.value
  const busy = gitBusy.value
  const err = gitError.value
  const isBusy = busy !== 'idle'

  // The same button, one step further: it opens the panel that says what is about to be committed
  // rather than committing on the spot with a generated message.
  function handleCommit() {
    void openCommit()
  }


  return (
    <div class="ink-git-footer">
      <div class="ink-git-line">
        <span class="ink-git-branch">
          <IconGitBranch size={14} />
          <span class="ink-git-branch-name">{status.branch}</span>
          {status.dirty ? <span class="ink-git-dirty-dot" aria-label="Uncommitted changes" /> : null}
        </span>
        <button
          class="ink-iconbtn ink-commit-btn"
          disabled={!status.dirty || isBusy || commitLoading.value}
          onClick={handleCommit}
          title="Commit"
        >
          <IconCommit size={14} title={busy === 'committing' ? 'Committing…' : 'Commit'} />
        </button>
      </div>
      {/* The button is the confirmation.
          It said what it would do and how much, and then asked again in running text set inside
          the status bar — a question, an answer and a second answer, with `commit(s)` standing in
          for a sentence nobody wanted to write twice, and the word counts shifting sideways to
          make room for it. Push is additive and outward-only: it sends commits that already exist
          to a remote that already exists, so a second click guards against nothing that the first
          one — aimed at a button reading "Push 10" — did not already mean.

          The state is a colour rather than a shape: the label goes quiet while it works, so the
          bar does not change size at the moment you are watching it. */}
      {status.hasRemote && status.ahead > 0 && (
        <button
          class={`ink-push-btn${busy === 'pushing' ? ' working' : ''}`}
          disabled={isBusy}
          onClick={() => { void pushVault() }}
          title={busy === 'pushing' ? 'Pushing…' : `Push ${status.ahead} to ${status.branch}`}
        >
          <IconPushArrow size={13} />
          {busy === 'pushing' ? 'Pushing…' : `Push ${status.ahead}`}
        </button>
      )}
      {err !== null && <span class="ink-git-error">{err}</span>}
    </div>
  )
}
