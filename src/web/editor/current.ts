/**
 * What the editor has *right now*, for the two moments when waiting is not an option.
 *
 * The editor syncs its text into `content` on a debounce, which is right for the ordinary case —
 * a signal that changed on every keystroke would re-render the application once per character.
 * But anything that reads `content` and then tears the editor down races that debounce, and loses
 * however much was typed in the last fraction of a second.
 *
 * Ending a live session did exactly that, and lost the whole session: the panel's button ran before
 * the debounce fired, so `content` still held the note as it was *before* anybody joined, and the
 * editor was rebuilt from it — discarding every word the session had produced. Measured, not
 * guessed: the e2e test passed the moment a wait was added after the last keystroke, which is the
 * signature of a race rather than of a missing save.
 *
 * A function rather than a signal: the answer is only ever wanted at the instant it is asked for.
 */

let reader: (() => string) | null = null

/** Registered by the editor while it is mounted, and withdrawn when it is not. */
export function provideEditorText(next: (() => string) | null): void {
  reader = next
}

/** The editor's own text, or null when there is no editor — a guest page that has not joined yet. */
export function editorText(): string | null {
  if (reader === null) return null
  try {
    return reader()
  } catch {
    // An editor mid-teardown answers nothing rather than throwing into a caller that is saving.
    return null
  }
}
