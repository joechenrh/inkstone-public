import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { ServerEvent } from '../shared/events.js'

export interface WatcherOptions {
  root: string
  onEvent: (event: ServerEvent) => void
  debounceMs?: number
  /**
   * Suppression window for self-writes. **Known limitation**: if a genuinely
   * external modification to the same path occurs within this window (not the
   * echo of our own write), that fs event will also be discarded as a
   * "self-write echo" — `markSelfWrite` uses only path + timestamp and cannot
   * distinguish "a late echo of our own write" from "a coincidentally same-path
   * external edit that happened to fall inside the window". The accepted
   * trade-off: the client won't receive an immediate push notification for that
   * external change, but the next time it saves, PUT /api/file's baseMtimeMs
   * optimistic-lock will detect the mtime mismatch and return a 409 with the
   * current disk state — the client can still discover the conflict, just
   * delayed until its own next write rather than via a WebSocket push. A more
   * precise approach (record a "pending" marker before the write, confirm/revoke
   * it using the actual mtime returned by the write, rather than a pure time
   * window) would require buffering events that arrive during the write window
   * per path; the engineering cost is out of scope here and is deferred to when
   * the agent write path is implemented.
   */
  selfWriteWindowMs?: number
  /**
   * Grace period for mtime-based deduplication after watcher startup, default
   * 2000ms. **Only within this window**: if a path's stat'd mtime is identical
   * to the previously recorded value, the event is classified as a
   * platform-level spurious replay (described in the #lastMtimes comment below)
   * and dropped without broadcasting. Once the window expires, the dedup logic
   * is completely inactive — it neither reads, checks, nor updates #lastMtimes
   * — so during steady-state operation, two genuinely distinct writes that
   * happen to land on the same mtime precision tick (e.g. low-precision
   * filesystems, network drives, some container volume drivers) are both
   * broadcast faithfully; the second one is never silently swallowed.
   */
  startupDedupMs?: number
}

export class VaultWatcher {
  #watcher: FSWatcher | null = null
  readonly #selfWrites = new Map<string, number>()
  readonly #pending = new Map<string, NodeJS.Timeout>()
  // Records each file's mtime baseline / last-broadcast value during the startup
  // grace period. On macOS, chokidar's fsevents backend occasionally replays a
  // spurious 'change' event for an unmodified sibling file when unrelated
  // filesystem activity occurs in the same directory (e.g. a neighbouring
  // directory is created) during the startup phase — reproduced empirically at
  // ~50%–90% frequency; the stat'd mtimeMs is identical to the baseline.
  // This cannot be filtered by debouncing (it comes in separate batches of real
  // events); the only defence is content-level mtime comparison.
  //
  // This dedup is active only before #dedupUntil (see #startupDedupMs), and
  // only discards events whose mtime exactly matches the recorded value — it
  // does not grow more aggressive over time. Once the grace period ends, this
  // map is never consulted again, preventing a coincidental write (two writes
  // landing on the same mtime precision tick) from being silently dropped as a
  // spurious event.
  readonly #lastMtimes = new Map<string, number>()
  readonly #root: string
  readonly #onEvent: (event: ServerEvent) => void
  readonly #debounceMs: number
  readonly #selfWriteWindowMs: number
  readonly #startupDedupMs: number
  #dedupUntil = 0

  constructor(opts: WatcherOptions) {
    this.#root = opts.root
    this.#onEvent = opts.onEvent
    this.#debounceMs = opts.debounceMs ?? 150
    this.#selfWriteWindowMs = opts.selfWriteWindowMs ?? 1500
    this.#startupDedupMs = opts.startupDedupMs ?? 2000
  }

  async start(): Promise<void> {
    // Scan existing files and record each mtime into #lastMtimes as a baseline.
    // Without a baseline, the first spurious platform 'change' event described
    // above fires before the file has ever been genuinely modified — with no
    // historical value to compare against, we would have to accept it. The
    // baseline ensures that even files that have never changed can be filtered
    // when they receive a first spurious event.
    await this.#seedBaseline(this.#root)
    this.#dedupUntil = Date.now() + this.#startupDedupMs

    this.#watcher = chokidar.watch(this.#root, {
      ignoreInitial: true,
      // Ignore any path whose components start with a dot: .git, .obsidian, .DS_Store, etc.
      ignored: (p) => path.relative(this.#root, p).split(path.sep).some((s) => s.startsWith('.')),
      awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 },
    })

    this.#watcher
      .on('add', (abs) => this.#schedule(abs, 'add'))
      .on('change', (abs) => this.#schedule(abs, 'change'))
      .on('unlink', (abs) => this.#schedule(abs, 'unlink'))
      .on('addDir', (abs) => this.#schedule(abs, 'add'))
      .on('unlinkDir', (abs) => this.#schedule(abs, 'unlink'))

    await new Promise<void>((resolve) => {
      this.#watcher!.once('ready', () => resolve())
    })
  }

  async stop(): Promise<void> {
    for (const timer of this.#pending.values()) clearTimeout(timer)
    this.#pending.clear()
    await this.#watcher?.close()
    this.#watcher = null
  }

  markSelfWrite(relPath: string): void {
    this.#selfWrites.set(this.#normalize(relPath), Date.now())
  }

  /** Recursively scan dir and record each file's current mtime into #lastMtimes; skip dot-prefixed path components to stay consistent with the ignored rule. */
  async #seedBaseline(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.#seedBaseline(abs)
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(abs)
          this.#lastMtimes.set(this.#normalize(path.relative(this.#root, abs)), stat.mtimeMs)
        } catch {
          // File was deleted between the readdir scan and the stat call — ignore;
          // nobody depends on a baseline for a file that no longer exists.
        }
      }
    }
  }

  #normalize(relPath: string): string {
    return relPath.split(path.sep).join('/')
  }

  #isSelfWrite(rel: string): boolean {
    const at = this.#selfWrites.get(rel)
    if (at === undefined) return false
    if (Date.now() - at > this.#selfWriteWindowMs) {
      this.#selfWrites.delete(rel)
      return false
    }
    return true
  }

  #schedule(abs: string, kind: 'add' | 'change' | 'unlink'): void {
    const rel = this.#normalize(path.relative(this.#root, abs))
    if (!rel || rel.startsWith('..')) return

    const key = `${kind}:${rel}`
    const existing = this.#pending.get(key)
    if (existing) clearTimeout(existing)

    this.#pending.set(
      key,
      setTimeout(() => {
        this.#pending.delete(key)
        void this.#emit(rel, kind)
      }, this.#debounceMs),
    )
  }

  async #emit(rel: string, kind: 'add' | 'change' | 'unlink'): Promise<void> {
    if (this.#isSelfWrite(rel)) return

    if (kind === 'unlink') {
      this.#lastMtimes.delete(rel)
      this.#onEvent({ type: 'file-removed', path: rel })
      this.#onEvent({ type: 'tree-changed' })
      return
    }

    if (kind === 'add') {
      this.#onEvent({ type: 'tree-changed' })
    }

    try {
      const stat = await fs.stat(path.join(this.#root, rel))
      if (stat.isFile()) {
        // See the #lastMtimes comment at the top of this class: only within the
        // startup grace period, and only when the mtime exactly matches the
        // recorded baseline / last-broadcast value, is the event classified as
        // a platform-level spurious event and dropped. Once the grace period
        // expires, this map is neither read nor updated — every genuine change
        // during steady-state operation is broadcast, even if it coincidentally
        // lands on the same mtime precision tick as the previous write.
        if (Date.now() < this.#dedupUntil) {
          if (this.#lastMtimes.get(rel) === stat.mtimeMs) return
          this.#lastMtimes.set(rel, stat.mtimeMs)
        }
        this.#onEvent({ type: 'file-changed', path: rel, mtimeMs: stat.mtimeMs })
      }
    } catch {
      // File was deleted between the event arrival and the stat call — ignore;
      // the unlink event will follow.
    }
  }
}
