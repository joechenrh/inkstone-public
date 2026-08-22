import type { ComponentChildren } from 'preact'
import './signin.css'

/**
 * The one surface in front of the app.
 *
 * All three states before a vault is open — sign in, install, choose — are this card with
 * different contents. They were three unstyled blocks floating at the top of a white page, which
 * read as three different unfinished things rather than one flow.
 *
 * The wordmark is the constant: same place, same size, and the subtitle beside it says which step
 * this is. That is a caption, not a step counter — it costs no chrome and needs no numbering.
 */
export function AuthCard({ step, children }: { step: string; children: ComponentChildren }) {
  return (
    <main class="ink-auth">
      <div class="ink-auth-card">
        <div class="ink-auth-mark">
          <b>Inkstone</b>
          <span>{step}</span>
        </div>
        {children}
      </div>
    </main>
  )
}
