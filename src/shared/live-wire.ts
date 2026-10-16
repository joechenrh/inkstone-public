/**
 * The three fields a session's document carries besides the document itself.
 *
 * In `src/shared` because both ends need the same strings and neither may import the other's tree:
 * the browser importing from `src/server/` would pull the server's dependencies into the bundle,
 * and a second copy of a string is a bug that only shows up in production.
 */

/** A plain `Y.Text` of the note's markdown, kept by whichever client is connected. */
export const MIRROR = 'markdown'
/** `Y.Array` of batches waiting for a client to apply them. */
export const INBOX = 'agentInbox'
/** `Y.Map` of results, keyed by batch id. */
export const RESULTS = 'agentResults'
