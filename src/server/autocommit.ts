import type { CommitResult, VaultGit } from './git/index.js'

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
const MAX_FILES_IN_MESSAGE = 3

export interface AutoCommitOptions {
  git: VaultGit
  intervalMs?: number
  now?: () => number
  onCommit?: (sha: string, files: string[]) => void
  onError?: (err: unknown) => void
}

function buildMessage(files: string[]): string {
  const shown = files.slice(0, MAX_FILES_IN_MESSAGE).join(', ')
  const rest = files.length - MAX_FILES_IN_MESSAGE
  return rest > 0 ? `autosave: ${shown} (+${rest} more)` : `autosave: ${shown}`
}

export class AutoCommit {
  readonly #git: VaultGit
  readonly #intervalMs: number
  readonly #now: () => number
  #onCommit?: (sha: string, files: string[]) => void
  readonly #onError?: (err: unknown) => void

  #dirty = false
  #lastCommitAt: number
  #timer: NodeJS.Timeout | null = null
  // Status flag indicating whether a #commit is currently in flight, used by
  // tick() to decide whether to skip the current beat — it is no longer the
  // mutex itself; the real mutual exclusion is handled by #queue below.
  #running = false
  // Fix round 1 / Finding 2: tick and commitNow now share a single queue
  // rather than each independently deciding whether to run. commitNow exists to
  // "take a guaranteed snapshot around an agent turn"; callers use its return
  // value to distinguish "genuinely nothing to commit" (null) from "the commit
  // attempt was displaced". If commitNow returned null just because a tick was
  // mid-flight, both outcomes would be indistinguishable to the caller, who
  // would mistakenly believe a snapshot had been taken. So commitNow queues and
  // waits, guaranteeing it runs its own real stageAll rather than being
  // displaced by another caller.
  #queue: Promise<unknown> = Promise.resolve()

  constructor(opts: AutoCommitOptions) {
    this.#git = opts.git
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.#now = opts.now ?? (() => Date.now())
    this.#onCommit = opts.onCommit
    this.#onError = opts.onError
    this.#lastCommitAt = this.#now()
  }

  /** Allows injecting or replacing the onCommit callback after construction (used by buildApp to wire in WsHub broadcasting). */
  setOnCommit(cb: (sha: string, files: string[]) => void): void {
    this.#onCommit = cb
  }

  /** Called after each successful write to disk; marks that there are pending changes to commit. */
  notifyWrite(): void {
    this.#dirty = true
  }

  /**
   * Checks whether a commit is due. Called by the timer and directly by tests.
   *
   * Unlike commitNow, tick skips the current beat immediately if a commit is
   * already in flight — the correct behaviour for a background loop: when the
   * timer fires faster than git can run, it is better to skip a beat (the next
   * tick will still see #dirty === true, so no intent is lost) than to pile up
   * requests behind #queue.
   */
  async tick(): Promise<void> {
    if (!this.#dirty) return
    if (this.#now() - this.#lastCommitAt < this.#intervalMs) return
    if (this.#running) return
    await this.#runExclusive(() => this.#commit((files) => buildMessage(files)))
  }

  /**
   * Immediately attempts a commit (used around an agent turn); returns null if
   * there are no changes.
   *
   * Unlike tick: commitNow must never silently give up just because a tick is
   * already in flight — it queues and waits for the running operation to fully
   * complete, then runs its own. This keeps null's sole meaning as "genuinely
   * nothing to commit", not conflated with "was displaced by a concurrent
   * operation".
   */
  async commitNow(message: string): Promise<CommitResult | null> {
    return this.#runExclusive(() => this.#commit(() => message))
  }

  /**
   * Chains tick/commitNow's actual commit work into a sequential queue: each
   * call must wait for the previous one to fully settle (success or failure)
   * before starting. This uses the same pattern as withPathLock in
   * routes/files.ts for serialising concurrent writes to the same path. Using
   * `prev.then(fn, fn)` rather than `prev.then(fn)` ensures a failure in one
   * call still lets the next one run — a single failure must not turn the whole
   * chain into a permanently rejected promise that deadlocks all subsequent
   * calls.
   *
   * Intentionally not declared async: the function body is fully synchronous
   * (no await), guaranteeing that "read current #queue, compute run, write back
   * new #queue" happens atomically within a single JS execution slice, leaving
   * no window for two near-simultaneous calls to step on each other's view of
   * #queue.
   */
  #runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn)
    // Regardless of whether run resolves or rejects, advance the chain to an
    // already-resolved state so the next queued call is not dragged down by
    // this one's failure.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #commit(message: (files: string[]) => string): Promise<CommitResult | null> {
    // #runExclusive already ensures only one #commit runs at a time; #running
    // here is just a status bit for tick() to decide whether to skip the
    // current beat — it no longer carries mutual exclusion responsibility.
    this.#running = true
    try {
      const files = await this.#git.stageAll()
      if (files.length === 0) {
        this.#dirty = false
        this.#lastCommitAt = this.#now()
        return null
      }
      const sha = await this.#git.commitStaged(message(files))
      this.#dirty = false
      this.#lastCommitAt = this.#now()
      this.#onCommit?.(sha, files)
      return { sha, files }
    } catch (err) {
      // Intentionally preserve #dirty=true and do not advance #lastCommitAt:
      // when git fails (e.g. a stale index.lock), the pending commit intent
      // must not be silently lost. The next tick will retry immediately
      // (because the time since the last successful commit was not reset by
      // this failed attempt), until git recovers or the caller addresses the
      // root cause. onError is called once per failure; rate-limiting any
      // alerting is the caller's responsibility.
      this.#onError?.(err)
      return null
    } finally {
      this.#running = false
    }
  }

  start(): void {
    if (this.#timer) return
    // #now() is a virtual clock injected by tests; it is not in sync with
    // setInterval's real wall clock. In production #now is always Date.now()
    // so the two are naturally aligned. Math.min(intervalMs, 30_000) ensures
    // that even when intervalMs is very large the timer still wakes up at most
    // every 30 s to check #dirty, avoiding a worst-case delay equal to the
    // entire intervalMs if a change happens between two timer firings.
    this.#timer = setInterval(() => {
      void this.tick()
    }, Math.min(this.#intervalMs, 30_000))
    // unref so this timer does not prevent process exit — it is a background
    // housekeeping task, not a reason the process must stay alive.
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }
}
