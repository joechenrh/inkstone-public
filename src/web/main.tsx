import { render } from 'preact'
import { githubIdentity } from './auth/github.js'
import './theme/tokens.css'
import './theme/base.css'
import { applyDocTheme, readDocTheme } from './theme/docThemes.js'
import { applyThemeChoice, readThemeChoice } from './theme/useTheme.js'
import { initSettings } from './state/settings.js'
import { initViewport } from './state/ui.js'
import { sharingAvailable } from './state/share.js'

initSettings()
initViewport()
// The document theme first: it decides which appearances are even available.
applyDocTheme(readDocTheme())
applyThemeChoice(readThemeChoice())

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

/**
 * Which kind of server this is, asked once before anything renders.
 *
 * A vault behind a password and a sign-in that leads to someone's own repository need different
 * first screens, and the browser cannot tell them apart on its own. A failure here is treated as
 * the vault, because that is the one whose failure the login gate can explain.
 */
async function signIn(): Promise<'github' | 'password'> {
  try {
    const res = await fetch('/api/config')
    if (!res.ok) return 'password'
    const cfg = await res.json() as { signIn: 'github' | 'password'; sharing?: boolean }
    // Whether this deployment was given anywhere to keep shared notes. Without it the Share item
    // never appears, rather than appearing and leading to a 404.
    sharingAvailable.value = cfg.sharing === true
    return cfg.signIn
  } catch {
    return 'password'
  }
}

/**
 * The one address this app has other than its own front door.
 *
 * Checked before anything else, and before the dev doors: a shared link is the only page a
 * stranger ever opens, and it must not depend on being signed in, on a repository having been
 * chosen, or on any of the state the app normally restores first.
 */
function sharedNoteId(): string | null {
  const match = /^\/share\/([^/?#]+)\/?$/.exec(location.pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/**
 * Every root is imported dynamically, which is what keeps the reader's page small: it is the only
 * page people who do not use this app ever open, and it has no business downloading an editor.
 */
async function start(): Promise<void> {
  const shared = sharedNoteId()
  if (shared !== null) {
    // This one page scrolls like a document. See the note at the top of `share/shared.css`.
    document.documentElement.setAttribute('data-page', 'shared')
    const { SharedNote } = await import('./share/SharedNote.js')
    // The identity is what makes Save possible; without one this server has no sign-in to offer
    // and the page is read-only for everybody, which is still a working page.
    const identity = await signIn() === 'github' ? githubIdentity() : null
    render(<SharedNote id={shared} identity={identity} />, root!)
    return
  }

  const vaultRoot = async () => (await import('./VaultRoot.js')).VaultRoot

  // Development doors, absent from a built app: Vite replaces this with `false` and drops the
  // import. An e2e test greps the bundles for their storage key to keep that true.
  if (import.meta.env.DEV) {
    const dev = await import('./dev-route.js')
    const config = dev.readDevConfig()
    if (config !== null) {
      if (config.mode !== 'identity' && dev.installDirectBackend(config)) {
        const VaultRoot = await vaultRoot()
        render(<VaultRoot />, root!)
        return
      }
      render(<dev.DevGitHubRoute config={config} />, root!)
      return
    }
  }

  if (await signIn() === 'github') {
    const { GitHubRoot } = await import('./auth/GitHubRoot.js')
    render(<GitHubRoot identity={githubIdentity()} />, root!)
    return
  }

  const VaultRoot = await vaultRoot()
  render(<VaultRoot />, root!)
}

void start()
