export interface VaultEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: VaultEntry[]
}

/** One commit that touched a particular file. */
export interface FileCommit {
  sha: string
  /** ISO 8601, author date. */
  date: string
  message: string
  /**
   * Lines added and removed, or `null` where the backend cannot say.
   *
   * Not every log carries them: GitHub's commit list has no per-file totals and asking for them
   * would be a request per row. Zero and "not known" are different facts, and collapsing them is
   * how the History panel came to describe every session of every note as "No textual change".
   */
  added: number | null
  removed: number | null
}

export interface SearchMatch {
  path: string
  /** 1-based, so it reads the way an editor's gutter does. */
  line: number
  /** The whole line the hit is on, trimmed. */
  text: string
}

/** One uncommitted file, with enough to decide whether to commit it. */
export interface PendingChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
  diff: string
}
