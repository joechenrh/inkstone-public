import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { closeCommit, commitChanges, commitError, commitOpen, runCommit } from '../state/commit.js'
import { isPhone } from '../state/ui.js'
import './commit.css'

/**
 * What is about to be committed, before committing it.
 *
 * The bottom row is the message field and nothing else. It carried a Commit button and a
 * "Commit & push" beside it, which was two problems: two controls of equal weight for one action
 * and one modifier, and — worse — a second way to push, when the status bar already has one with
 * its own confirmation. Push stays where push lives. Enter commits.
 *
 * A button does come back under a coarse pointer: a hint naming the return key is the thing this
 * app stopped doing on touch, and a panel with no visible way to finish is a dead end there.
 */
export function CommitPanel() {
  const open = commitOpen.value
  const [selected, setSelected] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const messageRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    setSelected(commitChanges.value[0]?.path ?? null)
    setMessage('')
    // `autoFocus` does nothing here. The attribute only applies while the document's autofocus
    // flag is unset, which the login form spent long ago, so anything mounted later opens
    // unfocused — the third time this has bitten in this app. Without it the message field never
    // has the keyboard and Enter, which is now the only way to commit on a desktop, does nothing.
    messageRef.current?.focus()
    // Layout, not plain effect: a plain one runs after paint, leaving a window where the panel is
    // on screen with no key listener bound — an Escape landing in it is dropped.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeCommit() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!open) return null

  const changes = commitChanges.value
  const shown = changes.find((c) => c.path === selected) ?? null

  const commit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { await runCommit(message) } finally { setBusy(false) }
  }

  return (
    <div class="ink-commit-scrim" onClick={closeCommit}>
      <div
        class={`ink-commit${isPhone.value ? ' ink-commit--sheet' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Commit"
        onClick={(e) => { e.stopPropagation() }}
      >
        <div class="ink-commit-head">
          <span class="ink-commit-title">Commit</span>
          <button type="button" class="ink-iconbtn" aria-label="Close commit" onClick={closeCommit}>✕</button>
        </div>

        {changes.length === 0
          ? <div class="ink-commit-note">Nothing to commit — the vault matches its last commit.</div>
          : (
            <>
              <div class="ink-commit-files">
                {changes.map((c) => (
                  <button
                    key={c.path}
                    type="button"
                    class={`ink-commit-file${c.path === selected ? ' on' : ''}`}
                    onClick={() => { setSelected(c.path) }}
                  >
                    <span class="ink-commit-path">{c.path}</span>
                    <span class="ink-commit-stat">
                      {c.status === 'deleted'
                        ? <span class="del">deleted</span>
                        : (
                          <>
                            {c.added > 0 && <span class="add">+{c.added}</span>}
                            {c.removed > 0 && <span class="del">−{c.removed}</span>}
                          </>
                        )}
                    </span>
                  </button>
                ))}
              </div>

              {shown && (
                <pre class="ink-commit-diff">
                  {shown.diff.split('\n').slice(0, 400).map((line, i) => (
                    <div
                      key={i}
                      class={line.startsWith('+') ? 'add'
                        : line.startsWith('-') ? 'del'
                          : line.startsWith('@@') ? 'hunk' : ''}
                    >
                      {line || ' '}
                    </div>
                  ))}
                </pre>
              )}

              <div class="ink-commit-foot">
                <input
                  class="ink-commit-message"
                  type="text"
                  placeholder="Describe the change"
                  aria-label="Commit message"
                  ref={messageRef}
                  value={message}
                  disabled={busy}
                  onInput={(e) => { setMessage((e.target as HTMLInputElement).value) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void commit() }}
                />

                {isPhone.value
                  ? (
                    <button type="button" class="ink-commit-go" disabled={busy} onClick={() => { void commit() }}>
                      {busy ? 'Committing…' : 'Commit'}
                    </button>
                  )
                  : <div class="ink-commit-hint">{busy ? 'Committing…' : '⏎ commits · esc cancels'}</div>}

                {commitError.value !== null && <div class="ink-commit-error">{commitError.value}</div>}
              </div>
            </>
          )}
      </div>
    </div>
  )
}
