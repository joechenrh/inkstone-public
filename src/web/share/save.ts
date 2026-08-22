import { backend, BackendError } from '../api/index.js'

export type Save =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; path: string }
  | { kind: 'already'; path: string }
  | { kind: 'failed'; detail: string }

/**
 * Write the copy, without ever overwriting a note the reader already has.
 *
 * Two copies is recoverable; a lost note is not. And a note whose text is already there is
 * recognised by that text rather than by its name, because saving the same shared note twice is
 * almost always a mis-click.
 */
export async function saveCopy(content: string, target: string): Promise<Save> {
  const dot = target.lastIndexOf('.')
  const stem = dot === -1 ? target : target.slice(0, dot)
  const ext = dot === -1 ? '' : target.slice(dot)

  for (let n = 1; n <= 20; n += 1) {
    const path = n === 1 ? target : `${stem} (${n})${ext}`
    let existing: string | null = null
    try {
      existing = (await backend.readFile(path)).content
    } catch (err) {
      // Anything other than "there is nothing there" is a real failure and must not be papered
      // over by writing to the next name along.
      if (!(err instanceof BackendError && err.status === 404)) throw err
    }

    if (existing === null) {
      await backend.writeFile(path, content)
      return { kind: 'saved', path }
    }
    if (existing === content) return { kind: 'already', path }
  }
  throw new Error('too many copies of this note already')
}
