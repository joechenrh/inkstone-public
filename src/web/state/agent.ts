import { signal } from '@preact/signals'
import {
  AgentError,
  dropSession,
  parsePairing,
  run as runOnAgent,
  status as askStatus,
  type BackendStatus,
  type Pairing,
  type RunEvent,
  type RunResult,
} from '../agent/api.js'
import { content, editContent, flushSave } from './document.js'
import { currentPath } from './vault.js'

/**
 * The agent, as the app holds it.
 *
 * Two rules from `docs/design/agent.md` live in this file rather than in the panel, because a rule
 * enforced in a component is a rule one more component can forget:
 *
 * - **The backend is named on every run and never inferred**, even when exactly one is installed.
 * - **Switching backend starts over.** A turn belongs to the backend that produced it.
 *
 * And one that shapes what is here at all: **a conversation belongs to a note.** Every note has its
 * own and they all stay alive, so switching notes switches the transcript with it and switching
 * back brings the other one intact. There is no "current conversation" that can be pointed at the
 * wrong document, which is a whole failure mode removed by keying on the thing the reader is
 * already looking at.
 *
 * The transcript here is only what is on screen. **The session itself lives in the binary** and no
 * id for it is held, sent or received — see `src/agent/sessions.ts`. Which means a reload empties
 * this and the next question still remembers.
 */

const PAIRING_KEY = 'inkstone.agent.pairing'
const BACKEND_KEY = 'inkstone.agent.backend'

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function safeSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* storage denied — the in-memory value still works for this session */ }
}

export type Connection =
  | { kind: 'unpaired' }
  | { kind: 'checking' }
  /** Nothing answered: not running, or this browser blocks loopback from an https page. */
  | { kind: 'offline' }
  /** Something answered and rejected the token. The pairing string changes every run. */
  | { kind: 'stale' }
  | { kind: 'ready'; machine: string; backends: BackendStatus[] }

export const pairing = signal<Pairing | null>(parsePairing(safeGet(PAIRING_KEY) ?? ''))
export const connection = signal<Connection>(
  pairing.value === null ? { kind: 'unpaired' } : { kind: 'checking' },
)

/**
 * Which backend runs the next prompt. Persisted, because it is a property of the person rather
 * than of the machine — which is also why the binary has no default and never picks one itself.
 */
export const chosenBackend = signal<string | null>(safeGet(BACKEND_KEY))

export interface Turn {
  prompt: string
  backend: string
  events: RunEvent[]
  /** When it was asked, so the wait can be shown as a number rather than as a spinner. */
  askedAt: number
  /** Null while it is still running. */
  result: RunResult | null
  /** The reader pressed Stop. Not a failure, and not shown as one. */
  stopped?: boolean
}

/**
 * Every note's transcript, keyed the way the binary keys its sessions.
 *
 * A plain object rather than a Map because signals compare by reference either way, and this is
 * read far more often than it is written.
 */
export const turnsByNote = signal<Record<string, Turn[]>>({})

/**
 * Which notes have a run in flight.
 *
 * **A run belongs to its note, not to the drawer.** Leaving a note while the agent is working does
 * not cancel it; the answer lands in that note's conversation and is there on the way back.
 * Anything else would make "look at something else for thirty seconds" cost the run.
 */
export const runningNotes = signal<string[]>([])

/** Set when a run comes back with a rewritten note that nobody has accepted yet, per note. */
export const proposalsByNote = signal<Record<string, { before: string; after: string }>>({})

/** What the drawer shows: the conversation for the note in front of the reader. */
export function turns(): Turn[] {
  const path = currentPath.value
  return path === null ? [] : turnsByNote.value[path] ?? []
}

export function isRunning(): boolean {
  const path = currentPath.value
  return path !== null && runningNotes.value.includes(path)
}

export function proposal(): { before: string; after: string; path: string } | null {
  const path = currentPath.value
  if (path === null) return null
  const p = proposalsByNote.value[path]
  return p === undefined ? null : { ...p, path }
}

const aborts = new Map<string, AbortController>()

function setTurns(path: string, next: Turn[]): void {
  turnsByNote.value = { ...turnsByNote.value, [path]: next }
}

function setProposal(path: string, value: { before: string; after: string } | null): void {
  const next = { ...proposalsByNote.value }
  if (value === null) delete next[path]
  else next[path] = value
  proposalsByNote.value = next
}

function setRunning(path: string, on: boolean): void {
  const has = runningNotes.value.includes(path)
  if (on === has) return
  runningNotes.value = on
    ? [...runningNotes.value, path]
    : runningNotes.value.filter((p) => p !== path)
}

/** The backends this agent has and can actually run, in the order the binary reported them. */
export function installed(): BackendStatus[] {
  const conn = connection.value
  return conn.kind === 'ready' ? conn.backends.filter((b) => b.found) : []
}

/**
 * The backend a run would use, or null if there is none to use.
 *
 * A remembered choice that is not on this machine resolves to null rather than to the first thing
 * available: the panel then says so and offers what is there. Substituting silently is the same
 * failure the binary refuses to make.
 */
export function activeBackend(): BackendStatus | null {
  const here = installed()
  if (chosenBackend.value === null) return here.length === 1 ? here[0]! : null
  return here.find((b) => b.id === chosenBackend.value) ?? null
}

export function setPairing(raw: string): boolean {
  const parsed = parsePairing(raw)
  if (parsed === null) return false
  pairing.value = parsed
  safeSet(PAIRING_KEY, `${parsed.host}/${parsed.token}`)
  connection.value = { kind: 'checking' }
  void refresh()
  return true
}

export function forgetPairing(): void {
  pairing.value = null
  safeSet(PAIRING_KEY, null)
  connection.value = { kind: 'unpaired' }
  turnsByNote.value = {}
  proposalsByNote.value = {}
}

/**
 * End the conversation for the note in front of the reader.
 *
 * The binary owns the session, so this asks rather than forgets: the workspace goes and the
 * backend's own record of the conversation — the file holding the note's text — goes with it.
 */
export async function startOver(): Promise<void> {
  const path = currentPath.value
  const at = pairing.value
  if (path === null) return
  setTurns(path, [])
  setProposal(path, null)
  if (at !== null) await dropSession(at, path).catch(() => { /* the transcript is cleared either way */ })
}

export function chooseBackend(id: string): void {
  if (chosenBackend.value === id) return
  chosenBackend.value = id
  safeSet(BACKEND_KEY, id)
  // Starting over, not carrying the last answers across. A turn belongs to the backend that
  // produced it, and showing it under a different name would misattribute it — for every note, not
  // just the one on screen.
  turnsByNote.value = {}
  proposalsByNote.value = {}
}

export async function refresh(): Promise<void> {
  const at = pairing.value
  if (at === null) { connection.value = { kind: 'unpaired' }; return }

  /**
   * True only if this answer is still about the pairing it was asked about.
   *
   * Removing the agent while a check was in flight left the panel stuck on "not answering": the
   * check failed a moment later and wrote `offline` over the `unpaired` that Remove had just set.
   * Offline is exactly the case that takes seconds to fail, so it was the one state where it
   * always happened.
   */
  const current = () => pairing.value?.token === at.token && pairing.value?.host === at.host

  try {
    const s = await askStatus(at)
    if (!current()) return
    connection.value = { kind: 'ready', machine: s.machine, backends: s.backends }
    // First contact with a machine that has exactly one: remember it, so the next prompt does not
    // have to ask. With several, the person picks — this never guesses between them.
    const here = s.backends.filter((b) => b.found)
    if (chosenBackend.value === null && here.length === 1) chooseBackend(here[0]!.id)
  } catch (err) {
    if (!current()) return
    connection.value = err instanceof AgentError && err.failure.kind === 'bad-token'
      ? { kind: 'stale' }
      : { kind: 'offline' }
  }
}

/**
 * Send the open note and a prompt.
 *
 * The note travels as the buffer has it, not as the disk has it: what a person is looking at is
 * what they mean, and asking about a version they cannot see would be a different question.
 */
export async function ask(prompt: string): Promise<void> {
  const at = pairing.value
  const backend = activeBackend()
  const path = currentPath.value
  if (at === null || backend === null || path === null) return
  if (runningNotes.value.includes(path) || prompt.trim() === '') return

  const before = content.value
  const abort = new AbortController()
  aborts.set(path, abort)
  setRunning(path, true)
  setProposal(path, null)

  // Appended, not replaced. The model has seen the earlier turns — the continuity is real now, so
  // a transcript is honest where a single turn used to be the only truthful thing to show.
  const index = (turnsByNote.value[path] ?? []).length
  setTurns(path, [
    ...(turnsByNote.value[path] ?? []),
    { prompt, backend: backend.id, events: [], askedAt: Date.now(), result: null },
  ])

  /** Everything writes through the index, because the reader may be looking at another note. */
  const patch = (fn: (turn: Turn) => Turn) => {
    const list = turnsByNote.value[path]
    const current = list?.[index]
    // Gone means the conversation was cleared or the backend switched under it. Late events belong
    // to a turn nobody is showing, and appending them would make a dead run look alive.
    if (list === undefined || current === undefined || current.prompt !== prompt) return false
    setTurns(path, list.map((t, i) => (i === index ? fn(current) : t)))
    return true
  }

  let result: RunResult
  try {
    result = await runOnAgent(
      at,
      // Search is always on. It was a toggle for one release, on the reasoning that it is the one
      // path where a note leaves the machine — but there is no agent worth wiring up that cannot
      // search, so the box was a tax every prompt paid to describe a choice nobody was making.
      // What crosses the wire is unchanged and still says so next to the sign-in promise.
      //
      // `title` is also the session key: the binary finds the conversation by the note's name,
      // which is why nothing here holds a session id.
      { backend: backend.id, note: before, prompt, title: path, search: true },
      (event) => { patch((t) => ({ ...t, events: [...t.events, event] })) },
      abort.signal,
    )
  } catch (err) {
    // Pressing Stop rejects the in-flight read, and what comes out is the browser's own internal
    // string — a reader saw "BodyStreamBuffer was aborted" in red where an answer should have been.
    // Stopping is something they did on purpose; it is not a failure and is not shown as one.
    if (abort.signal.aborted) {
      patch((t) => ({ ...t, stopped: true }))
      setRunning(path, false)
      aborts.delete(path)
      return
    }
    result = { ok: false, error: describe(err) }
    if (err instanceof AgentError && err.failure.kind === 'bad-token') connection.value = { kind: 'stale' }
    if (err instanceof AgentError && err.failure.kind === 'unreachable') connection.value = { kind: 'offline' }
  } finally {
    setRunning(path, false)
    aborts.delete(path)
  }

  if (!patch((t) => ({ ...t, result }))) return

  // A proposal, never an edit. The binary hands back the text it would write and the browser is
  // what applies it — so an agent's change arrives as an uncommitted change like any other, and is
  // reviewed before it enters anyone's repository.
  if (result.ok && result.changed && result.text !== null) {
    setProposal(path, { before, after: result.text })
  }
}

/** Stops the run for the note on screen. Another note's run is not the reader's to cancel here. */
export function stop(): void {
  const path = currentPath.value
  if (path === null) return
  aborts.get(path)?.abort()
  aborts.delete(path)
  setRunning(path, false)
}

/**
 * Take the proposal into the buffer, and save it.
 *
 * Saving here is a deliberate exception to the app's manual-save-only rule, and the reason it is
 * not a contradiction: Apply **is** the deliberate act. The reader has already read a diff and
 * pressed a button that says Apply — asking them to then press Ctrl+S is asking twice for one
 * decision, and the note that sits unsaved in between is the one place an agent's work can be lost
 * to a closed tab. Discard is right there for the other answer.
 *
 * Refused if the note moved on underneath it — the reader edited while the agent worked, or opened
 * something else. Applying then would silently drop whichever of the two happened second.
 */
export function applyProposal(): 'applied' | 'moved' {
  const p = proposal()
  if (p === null) return 'moved'
  if (currentPath.value !== p.path || content.value !== p.before) {
    setProposal(p.path, null)
    return 'moved'
  }
  editContent(p.after)
  setProposal(p.path, null)
  // Through the same serialized chain as Ctrl+S, so this cannot race a save the reader started —
  // and a failure surfaces in the conflict bar and the save-error bar exactly as a typed one does.
  void flushSave()
  return 'applied'
}

export function discardProposal(): void {
  const path = currentPath.value
  if (path !== null) setProposal(path, null)
}

function describe(err: unknown): string {
  // Anything that is not ours gets a sentence of ours. A browser's internal wording is not an
  // explanation to anybody, and it is the only thing a reader would see.
  if (!(err instanceof AgentError)) return 'the run did not finish'
  switch (err.failure.kind) {
    case 'unreachable': return 'the agent stopped answering'
    case 'bad-token': return 'this pairing string is no longer valid'
    case 'no-such-backend': return err.failure.id
    case 'not-installed': return err.failure.detail
    case 'refused': return err.failure.detail
  }
}
