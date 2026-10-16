import { computed, signal } from '@preact/signals'
import { hasIdentity, identityProvider } from '../auth/identity.js'
import { endSession, LiveError, mySession, startSession, type LiveStarted } from '../live/api.js'
import { connectLive, type LiveStatus, type LiveUser, type LiveWire } from '../live/provider.js'
import { editorText } from '../editor/current.js'
import { content, editContent, flushSave } from './document.js'
import { suspendedPath } from './suspend.js'
import { currentPath } from './vault.js'

/**
 * Whether a note is open for other people to edit, and what the panel is saying about it.
 *
 * One session at a time, which is the server's rule as well — the expensive thing is not the
 * document but the number of sockets anybody holding a link may write through. So this is a single
 * value rather than a map, and it is the one place the rest of the application asks.
 *
 * **What this does to the rest of the app, in two places only.** The editor is rebuilt when a
 * session starts or stops, because a collaborative document cannot carry the reveal plugins — they
 * put literal `**` in the document and every keystroke of that would travel to everyone else. And
 * `state/suspend.ts` holds this note's saving and committing for the duration, which is what was
 * asked for: the session ends with one write and one commit rather than a trail of them.
 */

/** Whether this deployment offers it at all, from `/api/config`. */
export const liveAvailable = signal(false)

/** The session this browser is hosting, or null. The owner's side only — a guest has no state. */
export const liveSession = signal<LiveStarted | null>(null)

/** The wire, while there is one. Held here so the panel can read who is in without the editor. */
export const liveWire = signal<LiveWire | null>(null)

export type LivePanel =
  | { kind: 'closed' }
  /** Before it starts: what pressing the button will do. */
  | { kind: 'offer'; path: string; title: string }
  | { kind: 'starting'; path: string }
  /** `selectable` only when the clipboard refused: the link is selected and nothing is said. */
  | { kind: 'running'; copied: boolean; selectable?: boolean }
  /** Ended, and reporting what happened — a panel that just vanishes says nothing. */
  | { kind: 'ended'; saved: boolean; guests: number }
  | { kind: 'failed'; detail: string }

export const livePanel = signal<LivePanel>({ kind: 'closed' })

/**
 * The session, but only when the note it is about is the one on screen.
 *
 * What the editor is keyed on. A session belongs to one note; the editor must be the ordinary one
 * for every other note, or opening a second note during a session would write into the session's
 * document instead of its own.
 */
export const liveHere = computed<LiveStarted | null>(() => {
  const session = liveSession.value
  return session !== null && session.path === currentPath.value ? session : null
})

/** How many other people are in, which is what the dot and the status bar count. */
export const livePeers = computed<LiveUser[]>(() => liveWire.value?.peers.value ?? [])
export const liveStatus = computed<LiveStatus | null>(() => liveWire.value?.status.value ?? null)

/** The owner's own colour. The app's link blue, so a guest's amber or green is plainly not theirs. */
export const OWNER_COLOR = '#4183c4'

async function token(): Promise<string | null> {
  if (!hasIdentity()) return null
  try {
    return await identityProvider().token()
  } catch {
    return null
  }
}

export function openLivePanel(path: string, title: string): void {
  livePanel.value = liveSession.value === null
    ? { kind: 'offer', path, title }
    : { kind: 'running', copied: false }
}

export function closeLivePanel(): void {
  livePanel.value = { kind: 'closed' }
}

/**
 * Open the note for other people.
 *
 * The note is saved first, for the same reason a share is taken from the saved file: what people
 * mean by this note is the one they can see, and a session seeded from a stale file would start by
 * throwing away whatever had not been written yet.
 */
export async function startLive(path: string, title: string): Promise<void> {
  livePanel.value = { kind: 'starting', path }
  try {
    await flushSave()
    const started = await startSession(await token(), path, title)
    liveSession.value = started
    // Saving and committing wait for the end of the session. See `state/suspend.ts`.
    suspendedPath.value = started.path
    liveWire.value = connectLive({
      id: started.id,
      ticket: started.ticket,
      user: { name: 'me', color: OWNER_COLOR },
    })
    livePanel.value = { kind: 'running', copied: false }
  } catch (error) {
    const detail = error instanceof LiveError
      ? error.message
      : 'This server could not be reached.'
    livePanel.value = { kind: 'failed', detail }
  }
}

/**
 * Close it, and keep what came of it.
 *
 * The order matters and is the reverse of what reads naturally: the text is taken off the editor
 * *before* the wire goes, because the editor's document is the collaborative one and tearing the
 * wire down first would leave nothing to save.
 */
export async function stopLive(): Promise<void> {
  const session = liveSession.value
  if (session === null) return
  const guests = livePeers.value.length
  let saved = false
  /*
   * The text off the editor itself, before anything is torn down.
   *
   * `content` lags the editor by a debounce, and the editor is about to be rebuilt from `content` —
   * so reading the signal here would rebuild it from the note as it stood *before the session* and
   * throw the whole conversation away. It did, until this line.
   */
  const text = editorText()
  if (text !== null && text !== content.value) editContent(text)
  try {
    await endSession(await token(), session.id)
  } catch {
    // The session is over for this browser whatever the server says; a socket that outlives the
    // page is the server's own clocks to collect.
  }
  liveWire.value?.destroy()
  liveWire.value = null
  liveSession.value = null
  // Released before the save, not after: this *is* the one write the session has been saving up for.
  suspendedPath.value = null
  try {
    await flushSave()
    saved = true
  } catch {
    saved = false
  }
  livePanel.value = { kind: 'ended', saved, guests: Math.max(0, guests - 1) }
}

/**
 * Pick up a session this account was already running, when the app opens.
 *
 * Without this a reload lands *beside* a running session rather than inside it: the link would
 * still work, the guests would still be typing, and this browser would be editing the file on its
 * own. Asked once, and it answers null for a browser that is not the owner's.
 */
export async function restoreLive(): Promise<void> {
  if (!liveAvailable.value) return
  const mine = await mySession(await token())
  if (mine === null) return
  liveSession.value = mine
  suspendedPath.value = mine.path
  liveWire.value = connectLive({
    id: mine.id,
    ticket: mine.ticket,
    user: { name: 'me', color: OWNER_COLOR },
  })
}
