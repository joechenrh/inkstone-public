import { signal } from '@preact/signals'

/**
 * The note whose saving and committing is on hold, or null.
 *
 * Its own module, and one line long, because both ends of it would otherwise import each other:
 * `state/live.ts` needs the document's save to set it, and the document's save needs to read it.
 *
 * **Why saving stops at all.** A live session is a conversation, and what it was halfway through is
 * nobody's history: the asked-for behaviour is one commit at the end. Holding the *commit* alone was
 * not enough on a vault deployment, where a save is a write to the file — the autosave timer wrote
 * the note on every pause, and a write whose base revision the previous write had just moved came
 * back as "the file has changed on disk", about the reader's own text. So the whole save waits, the
 * draft stays in local storage the way it does for any unsaved note, and the session ends with one
 * write and one commit.
 */
export const suspendedPath = signal<string | null>(null)
