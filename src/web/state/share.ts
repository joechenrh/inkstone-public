import { signal } from '@preact/signals'
import { backend } from '../api/index.js'
import { chosenRepo, hasIdentity, identityProvider } from '../auth/identity.js'
import { createShare, listShares, ShareError, stopShare, type ShareRecord } from '../share/api.js'
import { assetsFor } from '../share/assets.js'
import { currentPath } from './vault.js'
import { content, dirty, flushSave } from './document.js'

/**
 * Which notes are shared, and what the share panel is currently doing.
 *
 * There is no share list in the interface and there is not going to be one: a note knows whether
 * it is shared, and that is where extending and stopping live. This map exists so the *menu* can
 * say so without a request per row, and so a second device knows what the first one shared — the
 * server is the authority, not this browser.
 */

/** Whether this deployment offers sharing at all, from `/api/config`. */
export const sharingAvailable = signal(false)

/** Keyed by note path. Empty until {@link loadShares} has answered once. */
export const sharedByPath = signal<Record<string, ShareRecord>>({})

export type SharePanelState =
  | { kind: 'creating' }
  | { kind: 'ready'; url: string; expiresAt: number; copied: boolean; selectable: boolean }
  | { kind: 'busy'; url: string; expiresAt: number }
  | { kind: 'stopped' }
  | { kind: 'failed'; title: string; detail: string; retry: boolean }

/** The note the panel is about, or null when it is closed. */
export const sharePanelPath = signal<string | null>(null)
export const sharePanel = signal<SharePanelState>({ kind: 'creating' })

export const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days remaining, rounded up: "1 day left" should not appear with 23 hours to go. */
export function daysLeft(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / DAY_MS))
}

export function shareUrl(id: string): string {
  return `${location.origin}/share/${id}`
}

/**
 * What this account has shared, asked once when the app opens.
 *
 * Failure is silent on purpose: the consequence is a menu that says `Share…` where it could have
 * said `Shared · 28 days left`, and pressing it recovers on its own. An error bar for that would
 * be louder than the fact.
 *
 * That silence is also how this hid a real bug for a release. The identity used to be installed in
 * an effect, and Preact runs a child's effects before its parent's, so once the app began drawing
 * before the session had restored this ran with `hasIdentity()` still false — returning here, and
 * never trying again. Every menu said `Share…` while the server knew otherwise. **If the menu and
 * the server disagree, suspect this function first**, and note that pressing Share still returns
 * the original link, because the server is the one that knows.
 */
export async function loadShares(): Promise<void> {
  if (!sharingAvailable.value || !hasIdentity()) return
  try {
    const shares = await listShares(await identityProvider().token())
    sharedByPath.value = Object.fromEntries(shares.map((s) => [s.path, s]))
  } catch { /* the menu simply offers to share instead */ }
}

/**
 * Open the panel for a note — and create the link if there is not one yet.
 *
 * Opening never changes a share that already exists. `Share…` is the consent for making one;
 * after that, seeing the link must not be the same gesture as republishing the note, or checking
 * an old link would silently publish whatever has been written since.
 */
export function openSharePanel(path: string): void {
  sharePanelPath.value = path
  const existing = sharedByPath.value[path]
  if (existing !== undefined) {
    sharePanel.value = { kind: 'ready', url: shareUrl(existing.id), expiresAt: existing.expiresAt, copied: false, selectable: false }
    return
  }
  sharePanel.value = { kind: 'creating' }
  void publish(path)
}

export function closeSharePanel(): void {
  sharePanelPath.value = null
}

/** Re-share: replaces the reader's copy with the note as it is now, and resets the thirty days. */
export function reshare(): void {
  const path = sharePanelPath.value
  if (path === null) return
  const now = sharePanel.value
  if (now.kind === 'ready') sharePanel.value = { kind: 'busy', url: now.url, expiresAt: now.expiresAt }
  void publish(path)
}

export async function stopSharing(): Promise<void> {
  const path = sharePanelPath.value
  const record = path === null ? undefined : sharedByPath.value[path]
  if (path === null || record === undefined) return

  try {
    await stopShare(await identityProvider().token(), record.id)
    const next = { ...sharedByPath.value }
    delete next[path]
    sharedByPath.value = next
    // Not a silent close. Everything this action changes is somewhere the user cannot see — a
    // menu item behind a closed panel, and a link in somebody else's hands — so a panel that
    // simply vanished was indistinguishable from a button that did nothing.
    sharePanel.value = { kind: 'stopped' }
  } catch (err) {
    sharePanel.value = failureOf(err, 0)
  }
}

/**
 * Called from the panel's Copy button, and from nowhere else.
 *
 * The panel used to copy by itself the moment a link existed, which was wrong twice over: it
 * announced a copy nobody asked for and then took the word back two seconds later, and an
 * automatic clipboard write is exactly what iOS refuses outside a user gesture — so on a phone it
 * failed every time and put the button into its `Select` fallback for no reason. A press is a
 * gesture, so pressing the button works where the automatic write did not.
 */
export async function copyLink(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url)
  } catch {
    // iOS refuses the clipboard outside a user gesture, and a page on plain http has none at all.
    // A failure with an obvious manual fix does not deserve a sentence — the button becomes
    // Select and the link is already on screen to be selected.
    const now = sharePanel.value
    if (now.kind === 'ready') sharePanel.value = { ...now, selectable: true }
    return
  }
  const now = sharePanel.value
  if (now.kind === 'ready') sharePanel.value = { ...now, copied: true }
}

export function clearCopied(): void {
  const now = sharePanel.value
  if (now.kind === 'ready' && now.copied) sharePanel.value = { ...now, copied: false }
}

/**
 * Share the note as it is on disk — saving it first if it is the open one and has unsaved edits.
 *
 * A share is a copy, and the copy people mean is the note they can see. Publishing the last saved
 * version while the screen shows something newer is the kind of quiet disagreement that is only
 * discovered by the person who received the link.
 */
async function publish(path: string): Promise<void> {
  // Measured here rather than in the failure branch: by then the note may not be the open one,
  // and the sentence has to name the size of what was actually refused.
  let bytes = 0
  try {
    if (path === currentPath.value && dirty.value) await flushSave()
    const text = path === currentPath.value ? content.value : (await backend.readFile(path)).content
    bytes = new TextEncoder().encode(text).length
    const repo = chosenRepo.value
    const record = await createShare(await identityProvider().token(), {
      repo: repo === null ? '' : `${repo.owner}/${repo.name}`,
      path,
      title: titleOf(path, text),
      content: text,
      assets: await assetsFor(text),
    })

    sharedByPath.value = { ...sharedByPath.value, [path]: record }
    // Only if the panel is still about this note: a share started and then abandoned must not
    // reopen itself over whatever the user moved on to.
    if (sharePanelPath.value !== path) return
    sharePanel.value = {
      kind: 'ready',
      url: shareUrl(record.id),
      expiresAt: record.expiresAt,
      copied: false,
      selectable: false,
    }
  } catch (err) {
    if (sharePanelPath.value === path) sharePanel.value = failureOf(err, bytes)
  }
}

function failureOf(err: unknown, bytes: number): SharePanelState {
  const failure = err instanceof ShareError ? err.failure : { kind: 'offline' as const }
  switch (failure.kind) {
    case 'too-large':
      return {
        kind: 'failed',
        title: 'Too large to share',
        // Both numbers: "too large" alone leaves someone guessing how much to cut.
        detail: `This note is ${Math.ceil(bytes / 1024)}KB. Shared notes can be up to ${Math.round(failure.maxBytes / 1024)}KB.`,
        retry: false,
      }
    case 'too-many':
      return {
        kind: 'failed',
        title: 'Too many shared notes',
        detail: `You have ${failure.limit} notes shared, which is the limit. Stop sharing one first.`,
        retry: false,
      }
    case 'signed-out':
      return { kind: 'failed', title: 'Your session ended', detail: 'Sign in and share again.', retry: false }
    case 'refused':
      return { kind: 'failed', title: 'The server would not take it', detail: failure.detail, retry: true }
    default:
      return {
        kind: 'failed',
        title: 'Could not reach the server',
        // The half people actually want: a failed share must not leave anyone wondering whether
        // it half-happened.
        detail: 'Nothing was shared.',
        retry: true,
      }
  }
}

/**
 * What the reader's tab says.
 *
 * The first heading if the note has one, because that is what the note calls itself; otherwise the
 * file name, which is what the author called it.
 */
export function titleOf(path: string, text: string): string {
  const heading = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(text)
  if (heading?.[1]) return heading[1].trim()
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '')
}
