import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppDeps } from '../app.js'
import { broadcastGitStatus } from '../git-broadcast.js'
import type { AutoCommit } from '../autocommit.js'
import { VaultGitError, type VaultGit } from '../git/index.js'
import { VaultError, type Vault } from '../vault/index.js'
import { resolveSafe, VaultPathError } from '../vault/paths.js'
import type { VaultWatcher } from '../watcher.js'
import type { WsHub } from '../ws.js'

interface WriteBody {
  path?: unknown
  content?: unknown
  baseMtimeMs?: unknown
}

interface CreateBody {
  path?: unknown
  kind?: unknown
}

interface RenameBody {
  from?: unknown
  to?: unknown
}

interface DeleteBody {
  path?: unknown
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message })
}

/**
 * Chains multiple calls on the same key (here: the resolved absolute path from
 * PUT /api/file) so that each call must wait for the previous `fn()` to fully
 * settle (success or failure) before starting. This only addresses in-process
 * races — two requests reaching the same Fastify instance nearly simultaneously
 * are forced through the map so one completes its full read-check-write cycle
 * before the other begins, eliminating the TOCTOU window in the mtime check.
 *
 * It does not and is not intended to address out-of-process concurrent writes:
 * an agent, or a user editing vault files directly with an external
 * editor — those bypass this map entirely. The only defence for those cases
 * remains the baseMtimeMs-vs-disk comparison (409 returns the current disk
 * state for the client to handle).
 *
 * Memory: each key retains only the chain for currently running or queued work;
 * once the chain settles and no newer request has replaced the key, the entry
 * is deleted, so idle paths do not accumulate in the map. Using
 * `prev.then(fn, fn)` rather than `prev.then(fn)` ensures the next request
 * always runs regardless of whether the previous one succeeded or failed — a
 * single failure must not turn the chain into a permanently rejected deadlock.
 */
function withPathLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  // Used only to hand a settled promise to the next request in line: always
  // resolves, never propagates run's failure, and does not alter the result
  // that run itself returns or throws to the caller.
  const chained: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  )
  locks.set(key, chained)
  void chained.finally(() => {
    // Only delete if no later request has replaced this key with a new chain;
    // otherwise we would accidentally remove a chain that another caller is
    // still queued behind.
    if (locks.get(key) === chained) locks.delete(key)
  })
  return run
}

/**
 * Translates vault-layer exceptions into HTTP status codes.
 * Path errors are always 400 and only echo back the caller's own path, never
 * the resolved absolute path.
 *
 * VaultError messages come from the fixed ErrnoHandler templates at the top of
 * vault/index.ts (notFound/alreadyExists/notADirectory/isADirectory/
 * parentMissing/unexpected). Each template's message contains only the
 * caller's relPath, never the server's absolute path or raw errno text, so
 * classifying by message prefix and echoing the message to the client is safe.
 *
 * Classification (covers all VaultError variants vault layer can throw):
 *   - "not found: "                       -> 404: the resource does not exist
 *   - "already exists" (including rename's -> 409: conflicts with an existing
 *     "target already exists: ")               resource
 *   - "is a directory: " /                -> 409: the target path conflicts with
 *     "path segment is not a directory: "      a disk entry of the wrong type
 *                                              — semantically "conflict with
 *                                              current state", not "bad param".
 *   - "parent directory does not exist: "  -> 404: the required parent directory
 *                                              was not found.
 *   - "vault operation failed: "           -> 500. This is guardFs's fallback
 *     branch: only triggered when the errno does not match any known category
 *     (ENOENT/EEXIST/ENOTDIR/EISDIR etc.), e.g. EACCES, EPERM, ENOSPC, EMFILE
 *     — all server/environment problems, not invalid client input. Mapping them
 *     to 400 would mislead the client into thinking "fix your parameters". They
 *     are classified as 500 here; the original cause is logged for diagnosis
 *     (the module itself does not leak paths — the message template contains
 *     only relPath and is safe to echo — but 500 means operators need to know
 *     an unexpected fs failure occurred).
 *   - all others (e.g. "not a file: ",    -> 400 fallback: the request itself
 *     "unsafe asset extension: ")              fails a precondition unrelated
 *                                              to disk state.
 */
/**
 * The kinds of picture a note may carry, and what to serve them as.
 *
 * A closed list, not a guess from the extension: this is the one route that hands back bytes the
 * browser will render, and `Content-Type` is what decides whether they are a picture or a script.
 * `nosniff` goes with it. SVG is deliberately absent — it is a document that can carry script, and
 * serving one from the same origin as the notes is a decision of its own.
 */
const ASSET_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  avif: 'image/avif',
}

const ASSET_DIR = 'assets'

/** The browser re-encodes long before this; it is here so a direct caller cannot fill the disk. */
const MAX_ASSET_BYTES = 4 * 1024 * 1024

function sendVaultError(req: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (err instanceof VaultPathError) {
    return reply.code(400).send({ error: 'invalid path' })
  }
  if (err instanceof VaultError) {
    const msg = err.message
    if (msg.startsWith('not found:')) {
      return reply.code(404).send({ error: 'not found' })
    }
    if (msg.includes('already exists')) {
      return reply.code(409).send({ error: 'already exists' })
    }
    if (msg.startsWith('is a directory:') || msg.startsWith('path segment is not a directory:')) {
      return reply.code(409).send({ error: msg })
    }
    if (msg.startsWith('parent directory does not exist:')) {
      return reply.code(404).send({ error: msg })
    }
    if (msg.startsWith('vault operation failed:')) {
      req.log.error({ err }, 'unexpected vault fs failure')
      return reply.code(500).send({ error: 'internal error' })
    }
    return reply.code(400).send({ error: msg })
  }
  throw err
}

/**
 * Translates git-layer exceptions into HTTP status codes.
 * - No upstream / non-fast-forward push → 409 (conflicts with remote state)
 * - Authentication failure → 502 (upstream service refused)
 * - Other VaultGitError → 500
 * - Non-VaultGitError → re-throw; handled by the global setErrorHandler
 */
function sendGitError(reply: FastifyReply, err: unknown) {
  if (err instanceof VaultGitError) {
    const m = err.message
    if (/no upstream|not fast-forward|remote has changes|pull before/i.test(m))
      return reply.code(409).send({ error: m })
    if (/authenticat/i.test(m)) return reply.code(502).send({ error: m })
    return reply.code(500).send({ error: m })
  }
  throw err
}

// Hex only: these values reach a git command line, and nothing else may.
const SHA_RE = /^[0-9a-f]{7,40}$/

/**
 * The vault half of the HTTP surface.
 *
 * `AppDeps` makes the vault, git and autocommit optional because github mode has none of them;
 * this function is only reached when they exist, so it asks for them without the `?`.
 */
export type FileRouteDeps =
  Omit<AppDeps, 'vault' | 'git' | 'autoCommit'>
  & {
    vault: Vault
    git: VaultGit
    autoCommit: AutoCommit
    watcher: VaultWatcher
    hub: WsHub
  }

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  const { vault, git, config, hub } = deps

  // The check-and-write critical section of PUT /api/file is serialised per
  // resolved absolute path — see the withPathLock comment above.
  const writeLocks = new Map<string, Promise<unknown>>()

  app.get('/api/tree', async (req, reply) => {
    try {
      return await vault.tree()
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  // The whole corpus, once. Searching happens in the browser — see Vault.corpus.
  // What is about to be committed. The Commit button could not answer this before pressing it.
  app.get('/api/git/changes', async (req, reply) => {
    try {
      return { changes: await git.pendingChanges() }
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  app.get('/api/corpus', async (req, reply) => {
    try {
      return await vault.corpus()
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  app.get<{ Querystring: { path?: string } }>('/api/file', async (req, reply) => {
    const relPath = req.query.path
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return badRequest(reply, 'path query parameter is required')
    }
    try {
      const file = await vault.read(relPath)
      return { path: relPath, ...file }
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  /**
   * A picture, by the path the note refers to.
   *
   * `private`, not `public`: a vault sits behind one shared password, and `public` would invite
   * every proxy between here and the reader to keep a copy of something that needed a cookie to
   * fetch. `immutable` is a fact rather than a hope — the name is the hash of the bytes, so a name
   * can never come to mean anything else. This is the same reasoning `app.ts` applies to the
   * bundle's own content-addressed assets.
   */
  app.get<{ Querystring: { path?: string } }>('/api/asset', async (req, reply) => {
    const relPath = req.query.path
    if (typeof relPath !== 'string' || !relPath.startsWith(`${ASSET_DIR}/`)) {
      return badRequest(reply, 'path must name a file in the assets directory')
    }
    const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase()
    const type = ASSET_TYPES[ext]
    if (type === undefined) return badRequest(reply, 'not a kind of picture this serves')
    try {
      const bytes = await vault.readAsset(relPath)
      return reply
        .header('Content-Type', type)
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .send(bytes)
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  /**
   * Store a picture and say what to call it.
   *
   * The body is base64 rather than multipart: it arrives from a clipboard as bytes in a browser,
   * and one JSON request is less machinery than a form encoder on both ends. The name comes back
   * rather than going in — it is the hash of what was sent, so the same picture pasted twice is
   * written once, and `existed` says which of the two happened so the reader can be told.
   */
  app.post<{ Body: { bytes?: unknown; ext?: unknown } }>('/api/asset', async (req, reply) => {
    const { bytes, ext } = req.body ?? {}
    if (typeof bytes !== 'string' || bytes.length === 0) {
      return badRequest(reply, 'bytes must be a base64 string')
    }
    if (typeof ext !== 'string' || ASSET_TYPES[ext.toLowerCase()] === undefined) {
      return badRequest(reply, 'not a kind of picture this stores')
    }
    let buffer: Buffer
    try {
      buffer = Buffer.from(bytes, 'base64')
    } catch {
      return badRequest(reply, 'bytes is not base64')
    }
    if (buffer.byteLength === 0) return badRequest(reply, 'bytes is empty')
    if (buffer.byteLength > MAX_ASSET_BYTES) {
      return reply.code(413).send({ error: 'that picture is too large' })
    }
    try {
      return await vault.writeAsset(buffer, ext.toLowerCase())
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  app.put<{ Body: WriteBody }>('/api/file', async (req, reply) => {
    const { path: relPath, content, baseMtimeMs } = req.body ?? {}
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return badRequest(reply, 'path is required')
    }
    if (typeof content !== 'string') {
      return badRequest(reply, 'content must be a string')
    }
    if (baseMtimeMs !== undefined && typeof baseMtimeMs !== 'number') {
      return badRequest(reply, 'baseMtimeMs must be a number')
    }

    try {
      // Use the resolved absolute path as the lock key so that the same file
      // maps to the same lock regardless of how the client spelled the relative
      // path ('notes/a.md' vs './notes/a.md'). resolveSafe validation failures
      // (path traversal, NUL byte, etc.) throw before entering the lock and
      // fall through to the catch below.
      const abs = await resolveSafe(vault.root, relPath)
      return await withPathLock(writeLocks, abs, async () => {
        if (typeof baseMtimeMs === 'number') {
          const disk = await vault.read(relPath).catch((err) => {
            if (err instanceof VaultError) return null
            throw err
          })
          // Tolerate 1ms jitter: some filesystems have limited mtime precision.
          if (disk && Math.abs(disk.mtimeMs - baseMtimeMs) > 1) {
            return reply.code(409).send({
              error: 'file changed on disk',
              disk: { content: disk.content, mtimeMs: disk.mtimeMs },
            })
          }
        }
        // Must be marked before calling vault.write; marking after the write
        // risks the fs event arriving first.
        deps.watcher.markSelfWrite(relPath)
        const result = await vault.write(relPath, content)
        // Notify only after vault.write has genuinely succeeded; not hoisted
        // outside the try or called earlier: the 409 branch above (disk content
        // has changed) returns before reaching this line; if vault.write throws,
        // this line is skipped — preventing AutoCommit from being marked dirty
        // when nothing actually changed, which would cause the next tick to run
        // a pointless empty stageAll against a clean working tree.
        deps.autoCommit.notifyWrite()
        return result
      })
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  app.post<{ Body: CreateBody }>('/api/file', async (req, reply) => {
    const { path: relPath, kind } = req.body ?? {}
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return badRequest(reply, 'path is required')
    }
    if (kind !== 'file' && kind !== 'dir') {
      return badRequest(reply, "kind must be 'file' or 'dir'")
    }
    try {
      deps.watcher.markSelfWrite(relPath)
      if (kind === 'file') await vault.createFile(relPath)
      else await vault.createDir(relPath)
      // Fix round 1 / Finding 3: only notify after creation genuinely succeeds,
      // for the same reason as the notifyWrite in PUT /api/file — failure paths
      // such as "already exists" (409) throw before reaching here and fall into
      // the catch below, so AutoCommit is never mistakenly marked dirty.
      deps.autoCommit.notifyWrite()
      return reply.code(201).send()
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  app.post<{ Body: RenameBody }>('/api/file/rename', async (req, reply) => {
    const { from, to } = req.body ?? {}
    if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) {
      return badRequest(reply, 'from and to are required')
    }
    try {
      deps.watcher.markSelfWrite(from)
      deps.watcher.markSelfWrite(to)
      await vault.rename(from, to)
      deps.autoCommit.notifyWrite()
      return reply.code(204).send()
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  app.delete<{ Body: DeleteBody }>('/api/file', async (req, reply) => {
    const relPath = req.body?.path
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return badRequest(reply, 'path is required')
    }
    try {
      deps.watcher.markSelfWrite(relPath)
      await vault.remove(relPath)
      deps.autoCommit.notifyWrite()
      return reply.code(204).send()
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  app.get('/api/git/status', async (_req, reply) => {
    const status = await git.status()
    const info = await git.remoteInfo()
    return reply.send({
      dirty: status.dirty,
      branch: status.branch,
      hasRemote: info !== null,
      ahead: info?.ahead ?? 0,
    })
  })

  // The git routes take a path but do not read through the vault, so they need its path guard
  // explicitly — resolveSafe rejects absolute paths, .. traversal, NUL bytes and symlinks that
  // point outside the root. Letting an unchecked path reach a git argument is the whole risk.
  const assertInVault = async (relPath: string): Promise<void> => { await resolveSafe(vault.root, relPath) }

  // History for one note. `limit` is capped: a long-lived note has hundreds of autosave commits
  // and the panel groups them anyway, so there is no reason to ship the whole log.
  app.get<{ Querystring: { path?: string; limit?: string } }>('/api/git/log', async (req, reply) => {
    const relPath = req.query.path
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return badRequest(reply, 'path query parameter is required')
    }
    const asked = Number.parseInt(req.query.limit ?? '', 10)
    const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 200) : 100
    try {
      await assertInVault(relPath)
      return reply.send({ commits: await git.logForFile(relPath, limit) })
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  // The diff for one note across a range of commits — one writing session, not each autosave in it.
  app.get<{ Querystring: { path?: string; from?: string; to?: string } }>('/api/git/diff', async (req, reply) => {
    const { path: relPath, from, to } = req.query
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return badRequest(reply, 'path query parameter is required')
    }
    if (typeof to !== 'string' || !SHA_RE.test(to)) return badRequest(reply, 'to must be a commit sha')
    if (from !== undefined && from !== '' && !SHA_RE.test(from)) {
      return badRequest(reply, 'from must be a commit sha')
    }
    try {
      await assertInVault(relPath)
      const diff = await git.diffFileRange(from === undefined || from === '' ? null : from, to, relPath)
      return reply.send({ diff })
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  // A note's content at one commit. Reading only — restoring is the client writing it back through
  // the ordinary save path, so nothing here changes the working tree or the history.
  app.get<{ Querystring: { path?: string; sha?: string } }>('/api/git/file-at', async (req, reply) => {
    const { path: relPath, sha } = req.query
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return badRequest(reply, 'path query parameter is required')
    }
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) return badRequest(reply, 'sha must be a commit sha')
    try {
      await assertInVault(relPath)
      return reply.send({ content: await git.fileAtCommit(sha, relPath) })
    } catch (err) {
      return sendVaultError(req, reply, err)
    }
  })

  app.post<{ Body: { message?: unknown } }>('/api/git/commit', async (req, reply) => {
    const message =
      typeof req.body?.message === 'string' && req.body.message.trim()
        ? req.body.message
        : 'manual commit'
    try {
      const result = await git.commitAll(message)
      void broadcastGitStatus(git, hub)
      return reply.send(result)
    } catch (err) {
      return sendGitError(reply, err)
    }
  })

  app.post('/api/git/push', async (_req, reply) => {
    try {
      const result = await git.push()
      void broadcastGitStatus(git, hub)
      return reply.send(result)
    } catch (err) {
      return sendGitError(reply, err)
    }
  })

  app.get('/api/vault/info', async (_req, reply) => {
    return reply.send({ root: config.vault?.root ?? '' })
  })
}
