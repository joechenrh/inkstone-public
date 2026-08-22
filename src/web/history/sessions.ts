import type { FileCommit } from '../../shared/types.js'

/** A run of quiet this long ends a writing session. */
export const DEFAULT_GAP_MS = 30 * 60 * 1000

export interface Session {
  /** Deliberate commits stand alone; autosaves group. */
  kind: 'session' | 'anchor'
  /** Newest commit in the run — the "to" of its diff. */
  toSha: string
  /** The commit *before* the run, or null when the run reaches the file's first appearance. */
  fromSha: string | null
  /** ISO dates, oldest and newest in the run. */
  startDate: string
  endDate: string
  commits: number
  added: number | null
  removed: number | null
  /** True when this run contains the commit that first added the file. */
  isCreation: boolean
  /**
   * The message of a deliberate commit, when somebody wrote one.
   *
   * Empty for autosaves and for the generated text the Commit button used to write on its own —
   * a log of "vault: 3 files" says nothing, which is why this panel showed the time instead. Now
   * that a message can be written, the ones that were are worth showing.
   */
  message: string
}

/**
 * Autosave commits are machine-made; a manual one is somebody deciding a point was worth keeping.
 * Anything not written by the autosave loop counts as deliberate — including commits made outside
 * the app, in a terminal.
 */
function isAutosave(commit: FileCommit): boolean {
  return commit.message.startsWith('autosave:')
}

/** What the Commit button writes when the message box is left empty. */
function isGenerated(commit: FileCommit): boolean {
  return /^vault: \d+ file/.test(commit.message)
}

/**
 * Collapses a file's commit log into writing sessions, newest first.
 *
 * Autocommit runs every five minutes, so an afternoon of writing is a dozen commits to one note and
 * a week is hundreds. A row per commit is the wrong unit: it reports the timer, not the work. A run
 * of autosaves with no long gap in it is one sitting, and that is what the panel shows.
 *
 * `commits` must be newest-first, as `git log` returns them.
 */
/** The total across a run, or null when not one commit in it reported the number. */
function sum(run: FileCommit[], field: 'added' | 'removed'): number | null {
  const known = run.map((c) => c[field]).filter((n): n is number => n !== null)
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0)
}

export function groupSessions(commits: FileCommit[], gapMs: number = DEFAULT_GAP_MS): Session[] {
  const sessions: Session[] = []

  for (let i = 0; i < commits.length;) {
    const newest = commits[i]!
    let j = i

    // Deliberate commits never absorb their neighbours, so a run only extends across autosaves.
    if (isAutosave(newest)) {
      while (j + 1 < commits.length) {
        const next = commits[j + 1]!
        if (!isAutosave(next)) break
        const apart = Date.parse(commits[j]!.date) - Date.parse(next.date)
        if (!Number.isFinite(apart) || apart > gapMs) break
        j++
      }
    }

    const oldest = commits[j]!
    const run = commits.slice(i, j + 1)
    const beyond = commits[j + 1]

    sessions.push({
      kind: isAutosave(newest) ? 'session' : 'anchor',
      toSha: newest.sha,
      // The base of the diff is what came before the run. Absent means this run reaches the
      // beginning of the file's history, and the empty tree stands in server-side.
      fromSha: beyond?.sha ?? null,
      startDate: oldest.date,
      endDate: newest.date,
      commits: run.length,
      // `null` when no commit in the run carried a count, so the panel can tell "nothing changed"
      // from "nobody counted".
      added: sum(run, 'added'),
      removed: sum(run, 'removed'),
      // Only true if the log actually reaches that far; a truncated log has more behind it.
      isCreation: beyond === undefined,
      // Only a written one: a generated message is the timer talking, not a person.
      message: isAutosave(newest) || isGenerated(newest) ? '' : newest.message,
    })

    i = j + 1
  }

  return sessions
}
