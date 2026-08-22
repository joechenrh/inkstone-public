import path from 'node:path'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * How this server lets someone in, and what it holds.
 *
 * Two modes, and a deployment may have either or both:
 *
 * - **vault** — a directory on this machine, reached with one shared password. The original
 *   Inkstone, and the reason the deployment notes say to keep it off the public internet.
 * - **github** — no vault at all. Notes live in the user's own repository and the browser talks
 *   to GitHub directly; this server serves the app and exchanges a sign-in code for a token.
 *   See `docs/design/public-route.md`.
 *
 * Both set is the development arrangement: the GitHub route is preferred, and the vault stays
 * reachable behind its password.
 */
export interface Config {
  /** Null in github mode: there is no directory, and nothing on this disk to protect. */
  vault: { root: string; password: string } | null
  github: { clientId: string; clientSecret: string; appSlug: string | null } | null
  /**
   * Where shared notes are kept, or null for a deployment that does not offer sharing.
   *
   * The only state this server keeps that outlives a request. Off unless a directory is named,
   * because a feature that quietly starts writing to disk is not a feature anyone asked for.
   * See `docs/design/sharing.md`.
   */
  share: { root: string } | null
  sessionSecret: string
  listenAddr: string
  port: number
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const sessionSecret = env.SESSION_SECRET
  if (!sessionSecret) throw new ConfigError('SESSION_SECRET is required')

  const vault = readVault(env, sessionSecret)
  const github = readGitHub(env)
  const share = readShare(env, github)

  if (vault === null && github === null) {
    throw new ConfigError(
      'nothing to serve: set VAULT_ROOT and AUTH_PASSWORD for a local vault, '
      + 'or GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET for sign-in with GitHub',
    )
  }

  const portRaw = env.PORT ?? '7654'
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer in 1..65535, got ${portRaw}`)
  }

  return {
    vault,
    github,
    share,
    sessionSecret,
    listenAddr: env.LISTEN_ADDR ?? '127.0.0.1',
    port,
  }
}

function readVault(env: NodeJS.ProcessEnv, sessionSecret: string): Config['vault'] {
  const root = env.VAULT_ROOT
  const password = env.AUTH_PASSWORD

  if (!root && !password) return null
  // Half-configured is worse than unconfigured in both directions: a vault with no password is
  // an open directory, and a password with no vault guards nothing.
  if (!root || !password) {
    throw new ConfigError('VAULT_ROOT and AUTH_PASSWORD must be set together')
  }
  if (password === sessionSecret) {
    throw new ConfigError('AUTH_PASSWORD and SESSION_SECRET must differ')
  }
  return { root: path.resolve(root), password }
}

/**
 * Sharing needs an account to attribute a share to, and this server only knows one kind.
 *
 * Without that, `POST /api/share` would be an open text host on someone's domain — which is the
 * whole reason the design leans on the GitHub session rather than inventing one.
 */
function readShare(env: NodeJS.ProcessEnv, github: Config['github']): Config['share'] {
  const root = env.SHARE_DIR
  if (!root) return null
  if (github === null) {
    throw new ConfigError('SHARE_DIR needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET: every share is attributed to the account that made it')
  }
  return { root: path.resolve(root) }
}

function readGitHub(env: NodeJS.ProcessEnv): Config['github'] {
  const clientId = env.GITHUB_CLIENT_ID
  const clientSecret = env.GITHUB_CLIENT_SECRET

  if (!clientId && !clientSecret) return null
  // Half-configured means sign-in appears to work and then fails at the exchange, which is the
  // least debuggable moment to find out.
  if (!clientId || !clientSecret) {
    throw new ConfigError('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together')
  }
  return { clientId, clientSecret, appSlug: env.GITHUB_APP_SLUG ?? null }
}
