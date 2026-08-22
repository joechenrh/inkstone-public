/**
 * The working tree, for a vault that is a branch on GitHub.
 *
 * On this server the disk plays this part: Ctrl+S writes a file, and git sees it as an uncommitted
 * change. There is no disk here, so the same role is played by a record of *what changed since the
 * commit the editor is sitting on* — which is all a working tree ever is.
 *
 * **Durable, and deliberately `localStorage` rather than IndexedDB.** The plan said IndexedDB, for
 * one reason: uncommitted work must survive a closed tab. `localStorage` survives it just as well,
 * is synchronous, is already where this app keeps drafts, and can be tested without a browser —
 * and the thing it cannot do, hold megabytes, is not asked of it. This holds *changed* notes, not
 * the vault: a handful of files between commits, with a timer committing every five minutes.
 * Should a write ever exceed the quota it throws, and the save reports failure rather than
 * pretending; silently dropping the text would be the one unacceptable outcome.
 */

export type StoreEntry =
  | { kind: 'write'; content: string; rev: string; at: number }
  | { kind: 'delete' }
  /**
   * A directory made in the tree and not yet given a file.
   *
   * Git has no such thing — a tree holds no empty directories — so this one is local until a note
   * is written into it, and never appears in a commit. That is not a shortcoming to work around:
   * it is what an empty directory means in git.
   */
  | { kind: 'dir' }
  /**
   * A picture already uploaded, waiting only to be pointed at.
   *
   * The bytes are not here. They went to GitHub the moment they were pasted, as a blob that no
   * tree references — one request, invisible in the history, and garbage-collected if the commit
   * never comes. What is kept is the sha, about sixty bytes, because this store is `localStorage`
   * and a screenshot would eat the budget the notes are living in.
   *
   * A commit turns this into a tree entry pointing at a sha that already exists, so no blob is
   * created at commit time and nothing large is ever held in the browser.
   */
  | { kind: 'asset'; sha: string; at: number }

export interface StoreState {
  /** The commit the entries below are relative to, and the tree to build the next one from. */
  baseCommitSha: string
  baseTreeSha: string
  entries: Record<string, StoreEntry>
  /** Feeds the local revs handed out by `write`. Persisted so revs stay unique across a reload. */
  seq: number
}

const PREFIX = 'inkstone.gh:'

function emptyState(): StoreState {
  return { baseCommitSha: '', baseTreeSha: '', entries: {}, seq: 0 }
}

export class WorkingStore {
  readonly #key: string
  #state: StoreState

  constructor(id: { owner: string; repo: string; ref: string }) {
    this.#key = `${PREFIX}${id.owner}/${id.repo}@${id.ref}`
    this.#state = read(this.#key)
  }

  get baseCommitSha(): string { return this.#state.baseCommitSha }
  get baseTreeSha(): string { return this.#state.baseTreeSha }
  get isEmpty(): boolean { return Object.keys(this.#state.entries).length === 0 }

  entries(): [string, StoreEntry][] {
    return Object.entries(this.#state.entries)
  }

  get(path: string): StoreEntry | undefined {
    return this.#state.entries[path]
  }

  /**
   * Point the store at a commit, **keeping every entry**.
   *
   * The branch having moved is exactly when the entries matter most, and each one says what a
   * path's content should be rather than how it got there — so it stays meaningful against a
   * newer tree. Clearing them here would delete work the user has not committed, in order to keep
   * the bookkeeping tidy. The diffs simply redraw against the new base, and committing them is
   * then a deliberate "mine wins".
   */
  setBase(commitSha: string, treeSha: string): void {
    this.#state.baseCommitSha = commitSha
    this.#state.baseTreeSha = treeSha
    this.#flush()
  }

  /** After our own commit landed: the edits are in it, so the slate is clean at the new base. */
  rebase(commitSha: string, treeSha: string): void {
    this.#state = { baseCommitSha: commitSha, baseTreeSha: treeSha, entries: {}, seq: this.#state.seq }
    this.#flush()
  }

  write(path: string, content: string, at: number): string {
    const rev = `local:${++this.#state.seq}`
    this.#state.entries[path] = { kind: 'write', content, rev, at }
    this.#flush()
    return rev
  }

  /** Remember a picture that is already on GitHub as an unreferenced blob. */
  putAsset(path: string, sha: string, at: number): void {
    this.#state.entries[path] = { kind: 'asset', sha, at }
    this.#flush()
  }

  /**
   * `existsInBase` decides what deleting means: a note that was committed leaves a tombstone the
   * next commit acts on, while one created and deleted between commits just goes away.
   */
  remove(path: string, existsInBase: boolean): void {
    if (existsInBase) this.#state.entries[path] = { kind: 'delete' }
    else delete this.#state.entries[path]
    this.#flush()
  }

  makeDir(path: string): void {
    this.#state.entries[path] = { kind: 'dir' }
    this.#flush()
  }

  /** Forgets a path entirely, leaving whatever the base says about it to stand. */
  forget(path: string): void {
    delete this.#state.entries[path]
    this.#flush()
  }

  #flush(): void {
    // A failed write must be loud: this is the only copy of text that is not yet in a commit.
    localStorage.setItem(this.#key, JSON.stringify(this.#state))
  }
}

function read(key: string): StoreState {
  let raw: string | null = null
  try { raw = localStorage.getItem(key) } catch { return emptyState() }
  if (raw === null) return emptyState()
  try {
    const parsed = JSON.parse(raw) as Partial<StoreState>
    return {
      baseCommitSha: parsed.baseCommitSha ?? '',
      baseTreeSha: parsed.baseTreeSha ?? '',
      entries: parsed.entries ?? {},
      seq: parsed.seq ?? 0,
    }
  } catch {
    // Unreadable state is worse than none: it would be applied to a real tree.
    return emptyState()
  }
}
