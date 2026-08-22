import { computed, signal } from '@preact/signals'

/**
 * Where you have been, so that following a link is not a one-way door.
 *
 * A link between notes leaves the note you were reading, and the only ways back were the tree and
 * the Recent list on the empty screen — neither of which is where your eyes are. *A dead end is a
 * bug, not a missing button*, so this is a keystroke and no new chrome: `Cmd/Ctrl+[` and `]`,
 * Typora's own binding.
 *
 * Not `history.pushState`. The browser's back button belongs to the routes this application really
 * has — the vault, a shared note, the sign-in — and spending it on "the previous note" would make
 * Back mean two different things depending on how you got here. It is also not persisted: where you
 * have been is a fact about this sitting, and Recent already remembers across reloads.
 *
 * Deliberately *not* deduplicated. Reading a → b → a and pressing Back should return to b, which is
 * where you just were, rather than to whatever a stack that collapsed repeats had left.
 */

const past = signal<string[]>([])
const future = signal<string[]>([])

/** Suppresses the push that `openFile` would otherwise make while walking the history. */
let walking = false

export const canGoBack = computed(() => past.value.length > 0)
export const canGoForward = computed(() => future.value.length > 0)

/**
 * Record that `from` has been left for another note.
 *
 * Called by `openFile` with the note that was open before it. A new destination discards whatever
 * was ahead — the same rule every browser and editor uses, because a forward stack that survives a
 * new turning leads somewhere you did not come from.
 */
export function recordVisit(from: string | null): void {
  if (walking || from === null) return
  past.value = [...past.value, from]
  future.value = []
}

/** The note to go back to, and the bookkeeping for it. Null when there is nowhere to go. */
export function stepBack(current: string | null): string | null {
  const stack = past.value
  if (stack.length === 0) return null
  const to = stack[stack.length - 1] ?? null
  past.value = stack.slice(0, -1)
  if (current !== null) future.value = [current, ...future.value]
  return to
}

export function stepForward(current: string | null): string | null {
  const stack = future.value
  if (stack.length === 0) return null
  const to = stack[0] ?? null
  future.value = stack.slice(1)
  if (current !== null) past.value = [...past.value, current]
  return to
}

/** Run `open` without it counting as a new turning. */
export async function whileWalking(open: () => Promise<void>): Promise<void> {
  walking = true
  try {
    await open()
  } finally {
    walking = false
  }
}

/** Test seam, and what a signed-out session leaves behind. */
export function forgetVisits(): void {
  past.value = []
  future.value = []
  walking = false
}
