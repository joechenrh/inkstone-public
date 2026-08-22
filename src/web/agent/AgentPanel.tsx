import { useEffect, useRef, useState } from 'preact/hooks'
import {
  activeBackend,
  applyProposal,
  ask,
  discardProposal,
  chooseBackend,
  chosenBackend,
  connection,
  installed,
  isRunning,
  proposal,
  refresh,
  startOver,
  stop,
  turns,
  type Turn,
} from '../state/agent.js'
import { collapse, countChanges, diffLines } from './diff.js'
import { currentPath } from '../state/vault.js'
import './agent.css'

/**
 * The agent drawer.
 *
 * Everything it says is something it was told, never something it assumed. A version rather than
 * "connected", a machine name rather than "your computer", and where a backend is missing it names
 * the machine it is missing from — because on a phone that is the fact that cannot be inferred.
 *
 * The picker only exists when there is something to pick. One machine with one backend sees a
 * version number and nothing to click, which is the state most people will be in forever.
 */
export function AgentPanel() {
  const conn = connection.value
  const path = currentPath.value
  const [draft, setDraft] = useState('')
  const [moved, setMoved] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)

  // Asked when the drawer opens, not on a timer. A status that is one action stale is fine; a poll
  // running behind a closed drawer is a request per interval for a fact nobody is reading.
  useEffect(() => { void refresh() }, [])

  const here = installed()
  const active = activeBackend()

  // The three states that are only prose share one shape: a sentence in the panel's own voice, a
  // line of smaller detail under it, and at most one thing to press. Two full-size paragraphs and a
  // button stretched across the drawer read as a wall for what is, every time, one short fact.
  if (conn.kind === 'unpaired' || conn.kind === 'stale') {
    return (
      <div class="ink-agent">
        <div class="ink-agent-state">
          <p class="ink-agent-says">
            {conn.kind === 'stale' ? 'That pairing string has expired.' : 'No agent set up.'}
          </p>
          <p class="ink-agent-fine">
            {conn.kind === 'stale'
              ? 'It changes each time the agent starts. Paste the new line into Settings → Agent.'
              : <>Run <code>inkstone-agent</code> on your own machine and paste what it prints into Settings → Agent.</>}
          </p>
        </div>
      </div>
    )
  }

  if (conn.kind === 'checking') {
    return <div class="ink-agent"><p class="ink-agent-fine">Looking for the agent…</p></div>
  }

  if (conn.kind === 'offline') {
    return (
      <div class="ink-agent">
        <div class="ink-agent-state">
          <p class="ink-agent-says">The agent is not answering.</p>
          {/* Two causes, one symptom: `fetch` cannot tell a refused connection from a blocked one,
              so both are named rather than picking the likelier and being wrong in Safari. Named,
              not explained — the browser-by-browser table belongs in the design record. */}
          <p class="ink-agent-fine">It may not be running. Safari also blocks this.</p>
          <div class="ink-agent-controls">
            <button type="button" class="ink-agent-btn ghost" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }

  const busy = isRunning()
  const conversation = turns()

  const send = () => {
    if (draft.trim() === '' || busy || active === null) return
    setMoved(false)
    void ask(draft)
    setDraft('')
  }

  const onKey = (e: KeyboardEvent) => {
    // Enter sends, Shift+Enter breaks the line. A prompt is usually one line, and reaching for a
    // button after every one of them is the kind of friction that stops people asking.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div class="ink-agent">
      <header class="ink-agent-head">
        {/* The line that already answered "where is this running" is the one that answers "with
            what" — one control rather than two. With a single backend it is not a control at all. */}
        {here.length > 1
          ? (
            <select
              class="ink-agent-pick"
              aria-label="Which agent runs this"
              value={active?.id ?? ''}
              onChange={(e) => { chooseBackend((e.target as HTMLSelectElement).value) }}
            >
              {chosenBackend.value !== null && active === null && <option value="">Choose one…</option>}
              {here.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.id} · {conn.machine}
                </option>
              ))}
            </select>
          )
          : <span class="ink-agent-where">{conn.machine}</span>}
        {/* After the machine name, not before it: `margin-left: auto` on a first child only pushes
            it as far as the next one, so the two ended up jammed together as "NewJOECHENRH.LOCAL".

            Starting over has to be cheap, or one thread ends up carrying three subjects. A word
            rather than a button because it is rare and throws something away, and it is here only
            when there is something to end. */}
        {conversation.length > 0 && (
          <button type="button" class="ink-agent-new" onClick={() => void startOver()}>
            New
          </button>
        )}
      </header>

      {/* A version is a fact; "connected" is a claim. The backend is not named: the header above
          already says which machine, and the name belongs only where it carries information — the
          picker when there is a choice, and the message that says to install one. */}
      {active !== null && (
        <p class="ink-agent-version">
          <span class="ink-agent-dot" aria-hidden="true" />
          {active.version ?? 'version unknown'}
        </p>
      )}

      {here.length === 0 && (
        <p class="ink-agent-bad">
          The agent is running on {conn.machine}, and found nothing to run
          {conn.backends.length > 0 && <> — it looked for {conn.backends.map((b) => b.id).join(', ')}</>}.
        </p>
      )}

      {here.length > 0 && active === null && (
        <p class="ink-agent-bad">
          {chosenBackend.value} is not on {conn.machine}. Pick one of the {here.length} that are.
        </p>
      )}

      {path === null && <p class="ink-agent-note">Open a note to ask about it.</p>}

      {active !== null && path !== null && (
        <>
          <div class="ink-agent-ask">
            <textarea
              ref={box}
              class="ink-agent-box"
              rows={2}
              placeholder="Ask about this note…"
              aria-label="Ask the agent about this note"
              value={draft}
              disabled={busy}
              onInput={(e) => { setDraft((e.target as HTMLTextAreaElement).value) }}
              onKeyDown={onKey}
            />
            {/* No web-search toggle. Every agent worth wiring up can search, so the box was a tax
                every prompt paid to describe a choice nobody was making. */}
            <div class="ink-agent-controls ink-agent-controls--right">
              {busy
                ? <button type="button" class="ink-agent-btn ghost" onClick={stop}>Stop</button>
                : <button type="button" class="ink-agent-btn" onClick={send} disabled={draft.trim() === ''}>Ask</button>}
            </div>
          </div>

          {conversation.map((t, i) => (
            <TurnView
              key={i}
              turn={t}
              running={busy && i === conversation.length - 1}
              proposal={i === conversation.length - 1 ? proposal() : null}
              onApply={() => { if (applyProposal() === 'moved') setMoved(true) }}
            />
          ))}

          {moved && (
            <p class="ink-agent-bad">
              The note changed while the agent was working, so nothing was applied. Ask again to
              work from what is there now.
            </p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * One turn of the conversation.
 *
 * A run took eleven seconds to say anything and half a minute to finish. Behind a spinner that is
 * indistinguishable from a hang, so each event is shown as it arrives — and they are the binary's
 * four kinds, not any backend's own event shapes.
 *
 * A proposal stays attached to the turn that produced it: a diff detached from the sentence that
 * asked for it is a diff you have to remember the reason for.
 */
function TurnView(
  { turn: t, running, proposal: p, onApply }: {
    turn: Turn
    running: boolean
    proposal: { before: string; after: string; path: string } | null
    onApply: () => void
  },
) {
  // The final answer is the last thing the model said, so a run that has finished would otherwise
  // print it twice — once as the event that carried it and once as the result. Observed against a
  // real run: both read "Added one short sentence to the end of note.md."
  const answer = t.result?.ok === true ? t.result.answer.trim() : null
  const events = answer === null || answer === ''
    ? t.events
    : t.events.filter((e) => !(e.kind === 'said' && e.text.trim() === answer))

  return (
    <div class="ink-agent-turn">
      <p class="ink-agent-prompt">{t.prompt}</p>

      {events.map((e, i) => {
        if (e.kind === 'said') return <p key={i} class="ink-agent-said">{e.text}</p>
        // The whole command in the tooltip, one line on screen. See the note in agent.css.
        if (e.kind === 'ran') {
          return <p key={i} class="ink-agent-ran"><code title={e.command}>{e.command}</code></p>
        }
        if (e.kind === 'edited') return <p key={i} class="ink-agent-step">Edited the note</p>
        // `done` is deliberately not rendered. It arrives before the result does, so a run showed
        // "Finished" and then "Working…" — two lines contradicting each other on screen. What
        // finishes a run, for a reader, is the answer appearing.
        return null
      })}

      {t.result === null && running && <Waiting since={t.askedAt} />}
      {/* Stopping is something the reader did on purpose. */}
      {t.result === null && t.stopped === true && <p class="ink-agent-step">Stopped.</p>}

      {answer !== null && answer !== '' && <p class="ink-agent-answer">{answer}</p>}
      {t.result?.ok === false && <p class="ink-agent-bad">{t.result.error}</p>}
      {/* Observed rather than declared: the file was compared before and after, and nothing was
          asked of the model, so nothing could be got wrong. */}
      {t.result?.ok === true && !t.result.changed && (
        <p class="ink-agent-step">The note was left exactly as it was.</p>
      )}

      {p !== null && <Proposal proposal={p} onApply={onApply} />}
    </div>
  )
}

/**
 * The wait, as a number.
 *
 * Measured against real codex: **thirteen seconds before it says anything**, twenty-two to finish,
 * and nine to fourteen on a resumed turn. A motionless "Working…" over that is indistinguishable
 * from a hang — somebody watched one and pressed Stop. A counter that moves is the difference
 * between "it is thinking" and "it is broken", and the range says what normal looks like so nobody
 * has to learn it by waiting twice.
 */
function Waiting({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const seconds = Math.max(0, Math.round((now - since) / 1000))
  return (
    <p class="ink-agent-step">
      Working… {seconds}s
      {seconds < 40 && <span class="ink-agent-usual"> · usually 10–30s</span>}
    </p>
  )
}

function Proposal(
  { proposal: p, onApply }: {
    proposal: { before: string; after: string; path: string }
    onApply: () => void
  },
) {
  const lines = diffLines(p.before, p.after)
  const { added, removed } = countChanges(lines)
  const rows = collapse(lines)

  return (
    <div class="ink-agent-proposal">
      <div class="ink-agent-proposal-head">
        <span class="ink-agent-eyebrow">Proposed</span>
        <span class="ink-agent-delta">
          {added > 0 && <span class="p">+{added}</span>}
          {removed > 0 && <span class="m">−{removed}</span>}
        </span>
      </div>

      <pre class="ink-agent-diff">
        {rows.map((row, i) => row.kind === 'gap'
          ? <span key={i} class="g">{`⋯ ${row.hidden} unchanged`}{'\n'}</span>
          : (
            <span key={i} class={row.kind === 'add' ? 'a' : row.kind === 'del' ? 'd' : ''}>
              {row.text}{'\n'}
            </span>
          ))}
      </pre>

      {/* Apply writes the note and commits nothing — an agent's change arrives as an ordinary
          uncommitted change and goes through the same review as one. Saving is an exception to
          manual-save-only because Apply is already the deliberate act; see `applyProposal`. */}
      <div class="ink-agent-controls">
        <button type="button" class="ink-agent-btn" onClick={onApply}>Apply</button>
        <button type="button" class="ink-agent-btn ghost" onClick={discardProposal}>
          Discard
        </button>
      </div>
      <p class="ink-agent-fine">Applying saves the note. Nothing is committed.</p>
    </div>
  )
}
