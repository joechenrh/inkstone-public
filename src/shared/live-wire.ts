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
/**
 * `Y.Map` of which client is applying which batch, keyed by batch id.
 *
 * A batch must be applied exactly once. Every client in a room sees the same inbox, so without
 * this they all apply it: the deletions look right because they delete the same characters, and
 * every insertion happens once per client. Reported after one session with one guest in it — two
 * words came out as `Programmming` and `什么是是`.
 *
 * Concurrent claims are resolved by Yjs itself, so each client claims, waits for the claims to
 * settle, and applies only if the winning claim is its own.
 */
export const CLAIMS = 'agentClaims'
