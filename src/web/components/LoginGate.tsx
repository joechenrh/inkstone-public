import { useState } from 'preact/hooks'
import { auth, BackendError } from '../api/index.js'
import './logingate.css'

export interface LoginGateProps {
  onSuccess: () => void
}

export function LoginGate({ onSuccess }: LoginGateProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await auth.signIn(password)
      onSuccess()
    } catch (err) {
      setError(err instanceof BackendError && err.status === 401 ? 'Wrong password' : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form class="ink-login" onSubmit={submit}>
      <input
        type="password"
        value={password}
        placeholder="Password"
        autoFocus
        onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
      />
      <button type="submit" disabled={busy || password.length === 0}>
        Enter
      </button>
      {error && <p class="ink-login-error">{error}</p>}
    </form>
  )
}
