import { useState } from 'preact/hooks'
import { auth, BackendError } from '../api/index.js'
import './logingate.css'
import { AuthCard } from '../auth/AuthCard.js'

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
    <AuthCard step="open your vault">
    <form class="ink-login" onSubmit={submit}>
      <label class="ink-login-label" for="ink-vault-password">Password</label>
      <input
        id="ink-vault-password"
        type="password"
        value={password}
        placeholder="Password"
        autoFocus
        autoComplete="current-password"
        onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
      />
      <button class="ink-auth-go" type="submit" disabled={busy || password.length === 0}>
        Enter
      </button>
      {error && <p class="ink-login-error" role="alert">{error}</p>}
    </form>
    </AuthCard>
  )
}
