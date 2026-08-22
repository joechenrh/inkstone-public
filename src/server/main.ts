import { AutoCommit } from './autocommit.js'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { VaultGit } from './git/index.js'
import { ShareStore } from './share/store.js'
import { Vault } from './vault/index.js'

/**
 * The server no longer looks for an agent backend, and should not: the backend runs on the reader's
 * own machine, behind `src/agent`, and the server never learns its name. All that is left to check
 * here is the one thing the server itself cannot work without.
 */
async function preflight(git: VaultGit): Promise<void> {
  if (!(await git.isRepo())) {
    throw new Error(
      `VAULT_ROOT is not a git repository: ${git.root} — run 'git init' there first`,
    )
  }
}

const config = loadConfig(process.env)

// github mode has no directory on this machine: no vault, no repository, no autocommit, and
// nothing to preflight. See `docs/design/public-route.md`.
const vault = config.vault ? new Vault(config.vault.root) : undefined
const git = config.vault ? new VaultGit(config.vault.root) : undefined
const autoCommit = git
  ? new AutoCommit({ git, onError: (err) => console.error('autocommit failed:', err) })
  : undefined

if (git) await preflight(git)

// Enable Fastify's built-in pino logger at the level specified by LOG_LEVEL
// (default: "info"). This means req.log.error(...) in setErrorHandler actually
// emits — the "operator can still see the real error" half of the scrubbing
// guarantee is now live. Tests call buildApp() directly with logger:false, so
// they are unaffected and produce no log spam.
const logLevel = (process.env.LOG_LEVEL ?? 'info') as
  | 'fatal'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'trace'
  | 'silent'

const shareStore = config.share ? await ShareStore.open(config.share.root) : undefined

const { instance, watcher } = buildApp({
  config,
  vault,
  git,
  autoCommit,
  shareStore,
  logLevel,
})
await watcher?.start()
autoCommit?.start()

/**
 * The daily pass over the share store.
 *
 * Expiry alone is not enough: a share nobody ever opens is never read past its death, so its text
 * would sit on disk for as long as the machine lives. `unref` so this timer never holds the
 * process open on its own — a sweep is worth doing, not worth staying alive for.
 */
if (shareStore) {
  const sweep = () => {
    void shareStore.sweep(Date.now()).then(({ emptied, removed }) => {
      if (emptied || removed) console.log(`shares swept: ${emptied} emptied, ${removed} removed`)
    }, (err: unknown) => { console.error('share sweep failed:', err) })
  }
  sweep()
  setInterval(sweep, 24 * 60 * 60 * 1000).unref()
}

await instance.listen({ host: config.listenAddr, port: config.port })
const modes = [config.vault && 'vault', config.github && 'github', config.share && 'sharing']
  .filter(Boolean).join(' + ')
console.log(`inkstone listening on http://${config.listenAddr}:${config.port} (${modes})`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // instance.close() triggers the onClose hook which stops the watcher and
    // autocommit timer — the process won't be held open by an orphaned watcher.
    void instance.close().then(() => process.exit(0))
  })
}
