import { signal } from '@preact/signals'
import { backend } from '../api/index.js'

export const gitStatus = signal({ dirty: false, branch: 'main', hasRemote: false, ahead: 0 })
export const gitBusy = signal<'idle' | 'committing' | 'pushing'>('idle')
export const gitError = signal<string | null>(null)

export async function refreshGitStatus(): Promise<void> {
  try { gitStatus.value = await backend.gitStatus() } catch { /* keep the previous value */ }
}

export async function commitVault(): Promise<void> {
  gitBusy.value = 'committing'
  gitError.value = null
  try {
    const stamp = new Date().toLocaleString('sv')  // sv → YYYY-MM-DD HH:mm:ss
    await backend.commit(`manual: ${stamp}`)
    await refreshGitStatus()
  } catch (e) {
    gitError.value = e instanceof Error ? e.message : 'Commit failed'
  } finally {
    gitBusy.value = 'idle'
  }
}

/**
 * What the last git action is saying, for surfaces with no status bar of their own — which on a
 * phone is all of them. `working` and `done` clear themselves; an error waits to be read.
 */
export const gitNotice = signal<{ kind: 'working' | 'done' | 'error'; text: string } | null>(null)

let noticeTimer = 0

export function dismissGitNotice(): void {
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = 0
  gitNotice.value = null
}

export function sayGitNotice(kind: 'working' | 'done' | 'error', text: string): void {
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = 0
  gitNotice.value = { kind, text }
  // A failure stays: it is the only one of the three that might need reading twice.
  if (kind === 'done') noticeTimer = window.setTimeout(dismissGitNotice, 3200)
}

export async function pushVault(): Promise<void> {
  const ahead = gitStatus.value.ahead
  const branch = gitStatus.value.branch
  gitBusy.value = 'pushing'
  gitError.value = null
  sayGitNotice('working', `Pushing ${ahead} to ${branch}…`)
  try {
    await backend.push()
    await refreshGitStatus()
    sayGitNotice('done', `Pushed ${ahead} to ${branch}`)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Push failed'
    gitError.value = message
    sayGitNotice('error', message)
  } finally {
    gitBusy.value = 'idle'
  }
}
