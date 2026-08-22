import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * One conversation per note, owned entirely here.
 *
 * The browser holds no session id and sends none. It names the note it is looking at — the only
 * thing it reliably knows — and this finds or opens the conversation for it. An id split across
 * both halves is one fact in two places that can disagree: a tab reloading with a stale id, an id
 * for a session that has expired, a browser certain a conversation exists after the binary was
 * restarted. None of those states exist if the browser never holds one.
 *
 * Two consequences worth having. **The memory outlives the tab** — reload the page and the
 * transcript on screen is gone, but the next question still remembers. And **sweeping has one
 * owner**, where the workspaces and the thread files actually are.
 *
 * This is the first state in the binary that outlives a request, which was a deliberate property
 * until now. It is bounded three ways: a cap on how many notes hold one, an idle timeout, and the
 * process — nothing here survives closing the terminal.
 */

/** How many notes may hold a conversation at once. The oldest goes when a new one arrives. */
const MAX_SESSIONS = 8

/** Untouched for this long and it is swept: the workspace deleted, the thread file with it. */
const IDLE_MS = 30 * 60 * 1000

export interface Session {
  /** The note this belongs to, as the reader names it. */
  key: string
  /** Its workspace. Lives as long as the conversation, not as long as one turn. */
  dir: string
  /** What the backend calls the conversation. Null until the first turn has run. */
  thread: string | null
  /** The note as it stood when the last turn started, for noticing it changed underneath. */
  lastNote: string | null
  turns: number
  usedAt: number
}

export interface SessionDeps {
  /** Where thread files are written, so they can be deleted with the session that owns them. */
  home?: () => Promise<string | null>
  now?: () => number
  max?: number
  idleMs?: number
}

export class Sessions {
  readonly #open = new Map<string, Session>()
  readonly #deps: Required<Omit<SessionDeps, 'home'>> & { home: () => Promise<string | null> }

  constructor(deps: SessionDeps = {}) {
    this.#deps = {
      home: deps.home ?? (async () => null),
      now: deps.now ?? (() => Date.now()),
      max: deps.max ?? MAX_SESSIONS,
      idleMs: deps.idleMs ?? IDLE_MS,
    }
  }

  /**
   * The conversation for a note, opened if there is not one.
   *
   * Sweeping happens here rather than on a timer: a timer keeps a process awake to delete
   * directories nobody is waiting on, and the only moment the answer can matter is when somebody
   * asks. A binary left running overnight sweeps on the first prompt of the morning.
   */
  async for(key: string): Promise<Session> {
    await this.#sweep()
    const existing = this.#open.get(key)
    if (existing !== undefined) {
      existing.usedAt = this.#deps.now()
      return existing
    }

    // Evict before opening, not after: the cap is a ceiling on what exists, not on what is left
    // over. Oldest first, which is the only ordering that does not need a policy to explain.
    while (this.#open.size >= this.#deps.max) {
      const oldest = [...this.#open.values()].sort((a, b) => a.usedAt - b.usedAt)[0]
      if (oldest === undefined) break
      await this.drop(oldest.key)
    }

    const session: Session = {
      key,
      dir: await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-agent-')),
      thread: null,
      lastNote: null,
      turns: 0,
      usedAt: this.#deps.now(),
    }
    this.#open.set(key, session)
    return session
  }

  /** What the drawer needs to know without asking about each note in turn. */
  list(): { key: string; turns: number; usedAt: number }[] {
    return [...this.#open.values()].map(({ key, turns, usedAt }) => ({ key, turns, usedAt }))
  }

  peek(key: string): Session | undefined {
    return this.#open.get(key)
  }

  /** End one conversation: the workspace goes, and the thread file goes with it. */
  async drop(key: string): Promise<boolean> {
    const session = this.#open.get(key)
    if (session === undefined) return false
    this.#open.delete(key)
    await this.#erase(session)
    return true
  }

  /** On the way out. Nothing this holds should outlive the process that held it. */
  async closeAll(): Promise<void> {
    const all = [...this.#open.values()]
    this.#open.clear()
    await Promise.all(all.map((s) => this.#erase(s)))
  }

  async #sweep(): Promise<void> {
    const cutoff = this.#deps.now() - this.#deps.idleMs
    for (const session of [...this.#open.values()]) {
      if (session.usedAt < cutoff) await this.drop(session.key)
    }
  }

  async #erase(session: Session): Promise<void> {
    await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {})
    if (session.thread !== null) await forgetThread(await this.#deps.home(), session.thread)
  }
}

/**
 * Delete a backend's own record of a conversation.
 *
 * Multi-turn costs `--ephemeral`, whose entire job was *"run without persisting session files to
 * disk"* — so the conversation, **including the note's text**, is now written to a file. It is in
 * the private home rather than mixed into anyone's own history, and it is on the reader's own
 * machine where the notes already are. But it is a new file containing their notes, and the thing
 * that owns the session owns this too.
 *
 * The layout is `<home>/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<thread>.jsonl`, so the file
 * is found by walking rather than by computing a path — a date is not something to guess at, and
 * the layout belongs to a program that may change it.
 */
export async function forgetThread(home: string | null, thread: string): Promise<void> {
  if (home === null || thread === '') return
  const root = path.join(home, 'sessions')
  for (const file of await walk(root, 4)) {
    if (path.basename(file).includes(thread)) await fs.rm(file, { force: true }).catch(() => {})
  }
}

async function walk(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full, depth - 1))
    else out.push(full)
  }
  return out
}
