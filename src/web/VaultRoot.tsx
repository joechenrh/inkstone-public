import { useState } from 'preact/hooks'
import { App } from './App.js'
import { backend, BackendError } from './api/index.js'
import { LoginGate } from './components/LoginGate.js'
import { sessionLost } from './state/session.js'

/**
 * The app, when the notes are a directory behind one password.
 *
 * Its own module rather than a function in `main.tsx` so that the entry point imports neither this
 * nor the editor behind it until it knows which page it is on. A stranger opening a shared link
 * would otherwise download the whole editor to read one note.
 */
export function VaultRoot() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  if (authed === null) {
    void backend
      .tree()
      .then(() => setAuthed(true))
      .catch((err) => setAuthed(!(err instanceof BackendError && err.status === 401)))
    return null
  }

  // A session that ends mid-session sends the user back here rather than leaving a live-looking
  // app whose every action fails.
  const ok = authed && !sessionLost.value
  return ok
    ? <App />
    : <LoginGate onSuccess={() => { sessionLost.value = false; setAuthed(true) }} />
}
