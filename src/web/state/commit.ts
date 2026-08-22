import { signal } from '@preact/signals'
import type { PendingChange } from '../../shared/types.js'
import { backend } from '../api/index.js'
import { refreshGitStatus, sayGitNotice } from './git.js'

/**
 * The commit panel's state.
 *
 * The changes are fetched **before** the panel opens, not after. Opening first and loading into it
 * showed a 111px panel saying "Reading the changes…" that then jumped to 323px of content — a flash
 * on every press. Nothing is on screen until there is something to put in it; the button carries
 * the wait, which is where the press happened.
 */
export const commitOpen = signal(false)
export const commitLoading = signal(false)
export const commitChanges = signal<PendingChange[]>([])
export const commitError = signal<string | null>(null)

export async function openCommit(): Promise<void> {
  commitLoading.value = true
  commitError.value = null
  try {
    const { changes } = await backend.gitChanges()
    commitChanges.value = changes
    commitOpen.value = true
  } catch (err) {
    // A failure that never opens a panel needs somewhere to be said; the footer's error line
    // already exists for exactly this.
    commitError.value = err instanceof Error ? err.message : 'Could not read the changes'
  } finally {
    commitLoading.value = false
  }
}

export function closeCommit(): void {
  commitOpen.value = false
  commitError.value = null
}

/** Returns false when the commit failed, so the panel can stay open and say why. */
export async function runCommit(message: string): Promise<boolean> {
  commitError.value = null
  try {
    // An empty message means the generated one, so committing without thinking is one press.
    const result = await backend.commit(message.trim())
    // The re-pointing that used to be here is now the backend's `onCommitted`, because a commit
    // moves that base whoever asked for it — and the unattended timer never came through here, so
    // leaving a tab alone and then pressing Ctrl+S reported the reader's own text as somebody
    // else's change.
    await refreshGitStatus()
    closeCommit()
    sayGitNotice('done', result === null
      ? 'Nothing to commit'
      : `Committed ${result.files.length} file${result.files.length === 1 ? '' : 's'}`)
    return true
  } catch (err) {
    const text = err instanceof Error ? err.message : 'Commit failed'
    commitError.value = text
    sayGitNotice('error', text)
    return false
  }
}
