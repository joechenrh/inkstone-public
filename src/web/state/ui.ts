import { signal } from '@preact/signals'

export const leftPanelOpen = signal(true)
// Collapsed by default to avoid a bordered blank vertical strip on the right while
// editing (Ctrl+/ still toggles it).
export const rightPanelOpen = signal(false)

/**
 * Which of the drawer's two views is showing.
 *
 * Was `'outline' | 'codex'`, and both halves were wrong: the outline moved to the sidebar phases
 * ago, and the interface never names a backend — see `src/agent/backend.ts`.
 */
export const rightTab = signal<'history' | 'agent'>('history')
export const settingsOpen = signal(false)


export type SidebarView = 'files' | 'outline'

/** Which view the left sidebar is showing. Only one is visible at a time — each gets the
 *  full column, so headings are not truncated and the tree is not compressed. */
export const sidebarView = signal<SidebarView>('files')

/** Selects a sidebar view, opening the sidebar first if it is collapsed — otherwise the
 *  shortcut would appear to do nothing. */
export function setSidebarView(view: SidebarView): void {
  sidebarView.value = view
  if (!leftPanelOpen.value) leftPanelOpen.value = true
}

/**
 * Below this the app is one screen at a time. 720px so a landscape phone and any tablet keep the
 * two-pane layout, which is comfortable at that width — the phone layout exists because 390px
 * cannot hold two panes, not because touch demands it.
 */
export const PHONE_BREAKPOINT = 720

export const isPhone = signal(false)

/**
 * Which of the two screens the phone is on.
 *
 * A phone cannot show the list and the document at once, so it shows one and pushes to the other:
 * opening a note goes to the document, back returns to the list **without closing the file**, so
 * returning to it costs no reload and no lost draft.
 */
export const phoneScreen = signal<'list' | 'document'>('list')

/**
 * A sheet over the document, on a phone.
 *
 * The outline is a sidebar tab, which on a phone lives on the *other screen*: reaching it while
 * reading cost back, switch tab, tap a heading, and being pushed back into the note — three taps
 * and two screen changes to jump within the document you were already in. As a sheet it is two
 * taps and none.
 *
 * History is here too, for a blunter reason: as a drawer it replaced the note with no scrim and no
 * close, and the back arrow goes to the list rather than out of history — so the only way back was
 * the menu that opened it. A screen you can only leave through the menu that opened it is a bug.
 */
export const phoneSheet = signal<'outline' | 'history' | 'agent' | null>(null)

/**
 * True while a back-swipe is under way.
 *
 * The phone mounts one screen at a time, which is right — but it means a document sliding right
 * reveals the shell's own background rather than the list, and the list only appears once the
 * gesture has committed. For the length of the drag both are mounted, the list underneath, so the
 * movement shows what it is uncovering.
 */
export const phoneSwiping = signal(false)

export function togglePhoneSheet(which: 'outline' | 'history' | 'agent'): void {
  phoneSheet.value = phoneSheet.value === which ? null : which
}

export function closePhoneSheet(): void {
  phoneSheet.value = null
}

export function showPhoneList(): void {
  phoneScreen.value = 'list'
  phoneSheet.value = null
}

/** Called once at startup; the listener lives for the life of the page. */
export function initViewport(): void {
  if (typeof window === 'undefined' || !window.matchMedia) return
  const mq = window.matchMedia(`(max-width: ${PHONE_BREAKPOINT - 1}px)`)
  const apply = () => { isPhone.value = mq.matches }
  apply()
  mq.addEventListener('change', apply)
}

export function toggleLeftPanel(): void {
  leftPanelOpen.value = !leftPanelOpen.value
}

export function toggleRightPanel(): void {
  rightPanelOpen.value = !rightPanelOpen.value
}

export function openSettings(): void {
  settingsOpen.value = true
}

export function closeSettings(): void {
  settingsOpen.value = false
}
