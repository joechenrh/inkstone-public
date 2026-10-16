/**
 * What an agent may ask for, and the refusals that teach it to ask better.
 *
 * Shared by the server, which validates, and the browser, which applies — one definition, because
 * two would drift and the drift would be silent.
 *
 * **Every message here is read by a language model.** So each one names the op that is wrong and
 * says what was expected: a caller that could have fixed its own request is the one most likely to
 * be given "400 Bad Request" and no way forward. See `docs/design/live-agent.md`.
 */

export type LiveOp =
  | { find: string; replace: string }
  | { insertAfterHeading: string; text: string }
  | { append: string }

/** One request's worth, with an id the result is matched to. */
export interface LiveBatch {
  id: string
  ops: LiveOp[]
}

export type LiveFailure =
  | { kind: 'missing'; op: number; needle: string }
  | { kind: 'ambiguous'; op: number; needle: string; matched: number }

/**
 * What the browser writes back: the batch it finished, and why it finished nothing if it did.
 *
 * No version in it. The browser does not know the server's counter — the server reads the mirror
 * itself once the batch has landed — and a field each end guesses at is a field that disagrees.
 */
export interface LiveResult {
  id: string
  failure?: LiveFailure
}

/** Twenty is more than a person would ask for in one breath and fewer than a loop produces. */
export const MAX_OPS = 20

const SHAPE = 'expected find/replace, insertAfterHeading/text, or append'

export function parseOps(value: unknown): { ops: LiveOp[] } | { error: string } {
  if (!Array.isArray(value)) {
    return { error: 'send ops, not a document: [{"find":…,"replace":…}]' }
  }
  if (value.length === 0) return { error: 'no ops' }
  if (value.length > MAX_OPS) return { error: `too many ops: ${MAX_OPS} at a time` }

  const ops: LiveOp[] = []
  for (const [at, raw] of value.entries()) {
    const one = raw as Record<string, unknown> | null
    if (typeof one?.find === 'string' && typeof one.replace === 'string') {
      // An empty anchor matches everywhere, which is the same as matching nothing anybody meant.
      if (one.find === '') return { error: `op ${at}: find cannot be empty` }
      // Rebuilt rather than passed through: a `regex: true` nobody implemented must not reach the
      // browser looking like a promise.
      ops.push({ find: one.find, replace: one.replace })
      continue
    }
    if (typeof one?.insertAfterHeading === 'string' && typeof one.text === 'string') {
      if (one.insertAfterHeading === '') {
        return { error: `op ${at}: insertAfterHeading cannot be empty` }
      }
      ops.push({ insertAfterHeading: one.insertAfterHeading, text: one.text })
      continue
    }
    if (typeof one?.append === 'string') {
      ops.push({ append: one.append })
      continue
    }
    return { error: `op ${at}: ${SHAPE}` }
  }
  return { ops }
}
