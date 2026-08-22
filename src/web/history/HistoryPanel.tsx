import { useEffect, useState } from 'preact/hooks'
import { backend } from '../api/index.js'
import { content, dirty, editContent, modifiedAt } from '../state/document.js'
import { gitStatus } from '../state/git.js'
import { currentPath } from '../state/vault.js'
import { groupSessions, type Session } from './sessions.js'
import './history.css'

/** Bytes, not characters: a CJK note is three times the size its character count suggests. */
export function byteSize(text: string): string {
  const n = new TextEncoder().encode(text).length
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function relative(iso: string | number): string {
  const then = typeof iso === 'number' ? iso : Date.parse(iso)
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(then).toLocaleDateString()
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

/** Day buckets, so a session's row can be a time of day rather than a full date. */
function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (sameDay(d, today)) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (sameDay(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "14:05 – 17:40" for a run, a single time for one commit. */
function sessionWhen(s: Session): string {
  const from = time(s.startDate)
  const to = time(s.endDate)
  if (s.isCreation && s.commits === 1) return 'Created'
  return from === to ? to : `${from} – ${to}`
}

function DiffBody({ text, session }: { text: string; session: Session }) {
  // Everything above the first @@ is git's file header — two paths the reader already knows. The
  // @@ lines themselves are dropped too: "@@ -65,4 +65,4 @@" is a coordinate into a file nobody is
  // counting lines in. Where they separated hunks, a rule now does.
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('@@'))
  const hunks: string[][] = []
  for (const line of start === -1 ? [] : lines.slice(start)) {
    if (line.startsWith('@@')) { hunks.push([]); continue }
    if (line === '' || line.startsWith('\\')) continue   // trailing blank, "\ No newline at end of file"
    hunks[hunks.length - 1]?.push(line)
  }
  const shown = hunks.filter((h) => h.length > 0)
  if (shown.length === 0) {
    // The diff is the *net* change across the whole run, so a session where something was written
    // and then taken back out again is genuinely empty — while the row above still says "4 saves"
    // and "+12 −12", because those are summed per commit. Both numbers are true and together they
    // read as a bug. Say which one is which.
    // Three different things, and they were one. "No textual change" is a claim about the text and
    // needs a number behind it; the GitHub route's log carries none, so saying it there was saying
    // something nobody had checked — about every session of every note.
    const counted = session.added !== null || session.removed !== null
    const worked = (session.added ?? 0) > 0 || (session.removed ?? 0) > 0
    return (
      <p class="ink-hist-note">
        {worked
          ? `These ${session.commits} saves end where they started — the edits cancel out.`
          : counted
            ? 'No textual change.'
            : 'No diff to show for these saves.'}
      </p>
    )
  }

  return (
    <div class="ink-hist-diff">
      {shown.map((hunk, hi) => (
        <pre key={hi} class={`ink-hist-hunk${hi > 0 ? ' split' : ''}`}>
          {hunk.map((line, i) => {
            const cls = line.startsWith('+') ? 'a' : line.startsWith('-') ? 'd' : ''
            // The leading +/-/space is what the colour already says.
            return <span key={i} class={cls}>{line.slice(1)}{'\n'}</span>
          })}
        </pre>
      ))}
    </div>
  )
}

export function HistoryPanel() {
  const path = currentPath.value
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openSha, setOpenSha] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ sha: string; text: string } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  // Collapse only when the file changes. An expanded session must survive a reload of the log,
  // and must certainly survive typing.
  useEffect(() => {
    setOpenSha(null)
    setDiff(null)
    setPending(null)
  }, [path])

  // Reload on the file, and on the vault's git state — which changes when the autosave loop or the
  // Commit button writes history this list should show. Deliberately NOT on `dirty`: that flips on
  // every keystroke, and refetching there collapsed the open session while the user was typing.
  useEffect(() => {
    if (!path) { setSessions(null); return }
    let cancelled = false
    backend.gitLog(path)
      .then((r) => { if (!cancelled) { setSessions(groupSessions(r.commits)); setError(null) } })
      .catch((e: unknown) => {
        if (cancelled) return
        setSessions([])
        setError(e instanceof Error ? e.message : 'Could not read the history')
      })
    return () => { cancelled = true }
  }, [path, gitStatus.value])

  if (!path) {
    return <div class="ink-hist"><p class="ink-hist-note">No file open.</p></div>
  }

  // Expanding waits for the diff rather than showing a placeholder first. Measured: the fetch
  // takes ~20ms, so a "loading" line only ever appeared long enough to be a flicker — two layout
  // changes where the reader expects one. `pending` keeps the clicked row responsive without
  // moving anything.
  const toggle = (s: Session) => {
    if (openSha === s.toSha) { setOpenSha(null); setDiff(null); return }
    setPending(s.toSha)
    backend.gitDiff(path, s.fromSha, s.toSha)
      .then((r) => { setDiff({ sha: s.toSha, text: r.diff }); setOpenSha(s.toSha) })
      .catch(() => { setDiff({ sha: s.toSha, text: '' }); setOpenSha(s.toSha) })
      .finally(() => { setPending(null) })
  }

  // Restoring loads the old text into the editor as unsaved changes rather than writing anything.
  // Nothing is lost and nothing is committed until the user saves, and if they don't want it after
  // all, reopening the note throws it away.
  const restore = (s: Session) => {
    setRestoring(true)
    backend.fileAtCommit(path, s.toSha)
      .then((r) => { editContent(r.content) })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : 'Could not read that version') })
      .finally(() => { setRestoring(false) })
  }

  let lastDay: string | null = null

  return (
    <div class="ink-hist">
      <dl class="ink-hist-facts">
        <dt>Modified</dt><dd>{modifiedAt.value ? relative(modifiedAt.value) : '—'}</dd>
        <dt>Size</dt><dd>{byteSize(content.value)}</dd>
      </dl>

      <div class="ink-hist-log">
        <span class="ink-hist-eyebrow">History</span>

        {dirty.value && (
          <div class="ink-hist-entry pending">
            <span class="ink-hist-when">Not saved yet</span>
          </div>
        )}

        {error !== null && <p class="ink-hist-note">{error}</p>}
        {sessions === null && error === null && <p class="ink-hist-note">Loading…</p>}
        {sessions !== null && sessions.length === 0 && error === null && (
          <p class="ink-hist-note">This note has never been committed.</p>
        )}

        {(sessions ?? []).map((s) => {
          const day = dayLabel(s.endDate)
          const showDay = day !== lastDay
          lastDay = day
          const isOpen = openSha === s.toSha
          return (
            <div key={s.toSha}>
              {showDay && <div class="ink-hist-day">{day}</div>}
              {/* The accent rule and the open fill belong to the whole entry, not the row: on the
                  row alone the rule stopped a third of the way down an expanded entry and read as
                  a stray tick in its corner. */}
              <div class={`ink-hist-item${s.kind === 'anchor' ? ' anchor' : ''}${isOpen ? ' open' : ''}`}>
              <button
                type="button"
                class={`ink-hist-entry${isOpen ? ' open' : ''}${pending === s.toSha ? ' pending-diff' : ''}`}
                aria-expanded={isOpen}
                onClick={() => { toggle(s) }}
              >
                <span class="ink-hist-when">
                  {sessionWhen(s)}{s.kind === 'anchor' && !s.isCreation && s.message === '' ? ' · Commit' : ''}
                </span>
                <span class="ink-hist-delta">
                  {(s.added ?? 0) > 0 && <span class="p">+{s.added}</span>}
                  {(s.removed ?? 0) > 0 && <span class="m">−{s.removed}</span>}
                </span>
                {s.commits > 1 && <span class="ink-hist-peek">{s.commits} saves</span>}
                {/* A message somebody wrote — the reason the Commit button gained a message box.
                    Generated and autosave text is filtered out in sessions.ts, so anything here
                    was typed on purpose and is worth the row it takes. */}
                {s.message !== '' && <span class="ink-hist-message">{s.message}</span>}
              </button>

              {isOpen && diff?.sha === s.toSha && (
                <>
                  <DiffBody text={diff.text} session={s} />
                  <div class="ink-hist-actions">
                    <button type="button" class="ink-hist-restore" disabled={restoring} onClick={() => { restore(s) }}>
                      Restore this version
                    </button>
                  </div>
                </>
              )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
