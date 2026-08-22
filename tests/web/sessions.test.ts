import { describe, expect, it } from 'vitest'
import type { FileCommit } from '../../src/shared/types.js'
import { groupSessions } from '../../src/web/history/sessions.js'

const MIN = 60 * 1000
const base = Date.parse('2026-08-12T17:00:00Z')

/** minutesAgo counts backwards, so listing them in order gives a newest-first log. */
function commit(minutesAgo: number, message = 'autosave: a.md', added = 1, removed = 0): FileCommit {
  return {
    sha: `sha${minutesAgo}`.padEnd(7, '0'),
    date: new Date(base - minutesAgo * MIN).toISOString(),
    message,
    added,
    removed,
  }
}

describe('groupSessions', () => {
  it('collapses a run of autosaves five minutes apart into one session', () => {
    const log = [commit(0), commit(5), commit(10), commit(15)]
    const [session, ...rest] = groupSessions(log)
    expect(rest).toHaveLength(0)
    expect(session).toMatchObject({ kind: 'session', commits: 4, added: 4, toSha: log[0]!.sha })
    expect(session!.startDate).toBe(log[3]!.date)
    expect(session!.endDate).toBe(log[0]!.date)
  })

  it('starts a new session after a long enough silence', () => {
    const sessions = groupSessions([commit(0), commit(5), commit(120), commit(125)])
    expect(sessions).toHaveLength(2)
    expect(sessions.map((s) => s.commits)).toEqual([2, 2])
  })

  it('takes the gap as a parameter', () => {
    const log = [commit(0), commit(45)]
    expect(groupSessions(log, 30 * MIN)).toHaveLength(2)
    expect(groupSessions(log, 60 * MIN)).toHaveLength(1)
  })

  // Pressing Commit is the one real signal in a log of generated messages, so it is never merged
  // into the autosaves around it.
  it('keeps deliberate commits as their own entry', () => {
    const sessions = groupSessions([
      commit(0),
      commit(5, 'manual: 2026-08-12 16:55:00'),
      commit(10),
    ])
    expect(sessions.map((s) => s.kind)).toEqual(['session', 'anchor', 'session'])
    expect(sessions[1]!.commits).toBe(1)
  })

  it('treats a commit made outside the app as deliberate too', () => {
    const sessions = groupSessions([commit(0, 'Rewrite the awaiter section'), commit(5)])
    expect(sessions.map((s) => s.kind)).toEqual(['anchor', 'session'])
  })

  it('points each session at what came before it, for the diff base', () => {
    const log = [commit(0), commit(5), commit(120)]
    const [recent, older] = groupSessions(log)
    expect(recent!.fromSha).toBe(log[2]!.sha)
    // Nothing precedes the oldest entry in the log.
    expect(older!.fromSha).toBeNull()
    expect(older!.isCreation).toBe(true)
    expect(recent!.isCreation).toBe(false)
  })

  it('sums additions and removals across the run', () => {
    const sessions = groupSessions([commit(0, 'autosave: a.md', 3, 1), commit(5, 'autosave: a.md', 2, 4)])
    expect(sessions[0]).toMatchObject({ added: 5, removed: 5 })
  })

  it('returns nothing for a file with no history', () => {
    expect(groupSessions([])).toEqual([])
  })
})
