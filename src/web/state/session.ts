import { signal } from '@preact/signals'

/**
 * Set when the server rejects a request as unauthenticated.
 *
 * Whether the app shows the login form was decided once, at startup. Everything after that assumed
 * the session lasted forever, so a session that ended mid-edit left the app looking fine and doing
 * nothing: saves returned 401, the unsaved dot stayed, and there was no way back in short of
 * reloading — which the user had no reason to think of. One flag, set in the one place that sees
 * every response, is what makes that recoverable.
 */
export const sessionLost = signal(false)
