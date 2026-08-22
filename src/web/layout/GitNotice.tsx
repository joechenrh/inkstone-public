import { gitNotice, dismissGitNotice } from '../state/git.js'
import './gitnotice.css'

/**
 * What a git action says on a phone.
 *
 * There is no status bar there — the desktop's git footer, which carries the branch, the counts
 * and the error line, is not rendered on a phone at all. So tapping Push closed the menu and that
 * was the whole of it: measured, nothing at 150ms, 500ms or 1200ms, and no way to tell whether it
 * had worked except opening the menu again to look.
 *
 * The silence covered failures too, which is the part that decides the shape: this is not a success
 * chirp, it is the only place a git action can speak. So a failure stays until dismissed, and the
 * other two go on their own.
 *
 * Transient rather than permanent chrome: nothing is on screen when nothing has happened.
 */
export function GitNotice() {
  const notice = gitNotice.value
  if (notice === null) return null

  return (
    <div class={`ink-gitnotice${notice.kind === 'error' ? ' error' : ''}`} role="status">
      <span class="ink-gitnotice-text">{notice.text}</span>
      {notice.kind === 'error' && (
        <button type="button" class="ink-gitnotice-close" aria-label="Dismiss" onClick={dismissGitNotice}>
          ✕
        </button>
      )}
    </div>
  )
}
