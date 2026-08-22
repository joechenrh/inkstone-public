import { conflict, dismissSaveError, fileError, flushSave, openFile } from '../state/document.js'
import { refreshGitStatus } from '../state/git.js'
import './conflictbar.css'

/**
 * Everything that can go wrong with a save except a conflict.
 *
 * `saveError` was being set on every failed write and read by nothing, so a save that failed —
 * expired session, server down, disk full, permission denied — did exactly what a save that
 * succeeded did: nothing visible. The unsaved dot stayed on, which is the only reason the work
 * was not silently lost, but nothing said why, and pressing Ctrl+S again just failed again.
 *
 * The conflict case keeps its own bar: it is the one failure with a real choice to make.
 *
 * Two things can fail, not one. This said "Could not save" whatever had happened and offered a
 * Try again that ran a save — so a note that failed to *open* was reported as a save that had
 * never been attempted, and the button would have written the previous note's text. Both the
 * sentence and the button now come from which of the two it was.
 */
export function SaveErrorBar() {
  const failure = fileError.value
  if (failure === null || conflict.value) return null

  const retry = failure.kind === 'save'
    ? () => { void flushSave().then(() => refreshGitStatus()) }
    : () => { void openFile(failure.path) }

  return (
    <div class="ink-conflict" role="alert">
      <span>{failure.kind === 'save' ? 'Could not save' : 'Could not open'}: {failure.message}</span>
      <button type="button" onClick={retry}>
        Try again
      </button>
      <button type="button" onClick={dismissSaveError}>
        Dismiss
      </button>
    </div>
  )
}
