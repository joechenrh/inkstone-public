import type { VaultGit } from './git/index.js'
import type { WsHub } from './ws.js'

/**
 * Reads the current git status and remote info, then broadcasts a `git-status`
 * event to every connected WebSocket client. Called after any operation that
 * changes the git state: autocommit, manual commit, and push.
 *
 * Placed in its own module (not in app.ts) to avoid a circular import:
 * app.ts → routes/files.ts → git-broadcast.ts → git/index.ts + ws.ts.
 */
export async function broadcastGitStatus(git: VaultGit, hub: WsHub): Promise<void> {
  try {
    const status = await git.status()
    const info = await git.remoteInfo()
    hub.broadcast({
      type: 'git-status',
      dirty: status.dirty,
      branch: status.branch,
      hasRemote: info !== null,
      ahead: info?.ahead ?? 0,
    })
  } catch {
    // Best-effort UI-refresh signal — a transient git error (e.g. index.lock)
    // must never surface to the user or crash the autocommit loop. Swallow
    // silently; the next commit/push will trigger another broadcast attempt.
  }
}
