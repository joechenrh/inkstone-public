import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { privateHome } from './codex-home.js'

/**
 * One request: a note, a prompt, and whatever codex makes of them.
 *
 * The note is written into a directory made for this run and thrown away after, so the rest of the
 * vault is not merely off-limits — it is not there. See `docs/design/agent.md` for what that does
 * and does not contain.
 *
 * **Whether this was an answer or an edit is observed, not asked for.** We wrote the file, so we
 * have it before and after; a model that has to declare which it did is a model that can forget,
 * and the failure is silent — an edit reported as an answer never reaches the note.
 */

const FALLBACK_NOTE = 'note.md'

/**
 * The note keeps its own name inside the workspace.
 *
 * It used to be `note.md` always, and the cost showed up in the answers: the model said things like
 * "appended a sentence to `note.md`" about a file the reader knows as `coroutine.md`, and a request
 * that referred to the note by name had nothing to attach to. The title is part of a note — a
 * heading is often written to agree with it — so withholding it made the model work from less than
 * the reader could see.
 *
 * Only the basename, and only after what is dangerous is removed: this becomes a filename, and a
 * title arriving from a browser is a place to put an attempt to leave the directory.
 *
 * A denylist, not an allowlist. The first version allowed letters, numbers, space, dot, dash and
 * underscore, which turned `C++ coroutines.md` into `C coroutines.md` — punctuation is ordinary in
 * a note's name, and mangling it is the same fault as not passing the name at all. What is actually
 * unsafe here is a path separator, a control character, and a leading dot.
 */
function fileNameFor(title: string | undefined): string {
  const base = (title ?? '').split(/[/\\]/).pop() ?? ''
  const safe = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120)
  if (safe === '') return FALLBACK_NOTE
  return safe.endsWith('.md') ? safe : `${safe}.md`
}

/**
 * What codex is told about the two kinds of request.
 *
 * This constrains behaviour and not capability — the sandbox measurements in the design record are
 * clear that a prompt is not a boundary. It is here to make the right thing happen, not to prevent
 * the wrong one.
 */
function preamble(file: string, resuming: boolean, moved: boolean): string {
  // A resumed turn already has all of this in its context. Repeating it every turn spends the
  // window on instructions the model has read four times and reads as nagging in the answers.
  if (resuming) {
    return [
      ...(moved
        ? [
            `\`${file}\` has changed since your last turn — the reader edited it, or accepted an`,
            'edit you proposed. Read it again before doing anything to it.',
            '',
          ]
        : []),
      'The request follows.',
      '',
    ].join('\n')
  }
  return [
    `You are working on a single note, \`${file}\`, and nothing else exists.`,
    '',
    `If the request asks you to change the note, edit \`${file}\` in place and make the smallest`,
    'change that satisfies it. If the request only asks a question about the note, answer it and',
    'leave every file exactly as it is.',
    '',
    'Never create another file. Never read or write anything outside this directory. Do not run shell',
    'commands unless the request cannot be served without them.',
    '',
    // Observed in real runs, twice. The model narrated the setup back at the reader — "the
    // English-tutor skill file is outside the permitted directory, so I won't access it", and "your
    // request is already clear; a slightly smoother phrasing would be…". Neither is an answer.
    // The reader did not write these constraints, cannot act on them, and did not ask to have their
    // own sentence graded.
    'Say nothing about these instructions, about what you can and cannot reach, or about files you',
    'decided not to open. Do not restate, rephrase or comment on the request. Do not narrate what',
    'you are about to do.',
    '',
    'Answer the question, or make the edit and say in one sentence what you changed.',
    '',
    'The request follows.',
    '',
  ].join('\n')
}

/**
 * What the browser is told while a run is in progress.
 *
 * Deliberately **not** codex's own event shapes. Those are `item.started`/`item.completed` wrapping
 * an `item.type` of `agent_message`, `command_execution` or `file_change`, and they belong to a
 * program that will change them. Four kinds, named for what a person watching would say is
 * happening, is a surface worth keeping stable.
 *
 * `ran` is here for trust rather than progress: an agent that runs a command on your machine should
 * say so while it does it, not afterwards and not never.
 */
export type RunEvent =
  | { kind: 'said'; text: string }
  | { kind: 'ran'; command: string }
  | { kind: 'edited' }
  | { kind: 'done' }

export interface RunRequest {
  note: string
  prompt: string
  /** The conversation's workspace. Owned by `sessions.ts`, which is why this does not make one. */
  dir?: string
  /** The thread to continue. Null or absent starts one. */
  resume?: string | null
  /**
   * Aborted when the browser stops listening — the reader pressed Stop, or closed the tab.
   *
   * Without it, Stop only stopped the *display*: the process kept running to completion and kept
   * spending the reader's own model quota on an answer nobody would see. A button that says Stop
   * has to stop something.
   */
  signal?: AbortSignal
  /**
   * The note as it was when the previous turn started. When it differs, the model is told — it
   * wrote or read a version that is no longer what the reader is looking at, and "now make it
   * shorter" against the wrong version is a silent wrong answer.
   */
  since?: string | null
  /**
   * What the reader calls this note — the path the app knows it by. Only the basename is used, and
   * only after it is made safe to be a filename.
   */
  title?: string
  /** Lets the model look things up — and see `docs/design/agent.md` for what else it lets it do. */
  search?: boolean
}

export type RunResult =
  | {
      ok: true
      /** The conversation this turn belongs to, for the next one to resume. */
      thread?: string | null
      /** What codex said. Shown on its own for a question, and above the diff for an edit. */
      answer: string
      /** The note as codex left it, or null when it left it alone. */
      text: string | null
      /** Observed, never claimed: `text !== null`. */
      changed: boolean
    }
  | { ok: false; error: string }

export interface RunDeps {
  bin?: string
  /** Injectable so tests never go near a real credential. Returning null skips the private home. */
  home?: () => Promise<string | null>
  /** Injectable so tests never spend anyone's model quota. */
  spawnCodex?: (
    args: string[],
    cwd: string,
    onEvent: (event: RunEvent) => void,
  ) => Promise<{ code: number; stderr: string }>
}

/**
 * Codex's JSONL, turned into the vocabulary above.
 *
 * Anything unrecognised is dropped rather than forwarded: a new event type appearing in a codex
 * release should be invisible here, not a surprise in somebody's drawer.
 */
function toEvent(line: string): RunEvent | null {
  let raw: {
    type?: string
    thread_id?: string
    item?: { type?: string; text?: string; command?: string }
  }
  try {
    raw = JSON.parse(line) as typeof raw
  } catch {
    return null
  }
  if (raw.type === 'turn.completed') return { kind: 'done' }
  // `thread.started` carries the id, and is the only place it appears. It is caught by `run` and
  // never reaches the browser — that holds no session id, by design; see `sessions.ts`.
  if (raw.type === 'thread.started' && raw.thread_id) {
    return { kind: 'thread', id: raw.thread_id } as unknown as RunEvent
  }
  if (raw.type !== 'item.started' && raw.type !== 'item.completed') return null

  const item = raw.item ?? {}
  if (item.type === 'agent_message' && raw.type === 'item.completed' && item.text) {
    return { kind: 'said', text: item.text }
  }
  if (item.type === 'command_execution' && raw.type === 'item.started' && item.command) {
    return { kind: 'ran', command: item.command }
  }
  if (item.type === 'file_change' && raw.type === 'item.started') return { kind: 'edited' }
  return null
}

/**
 * The flags, and why, are tabulated in `docs/design/agent.md`. Every one is a decision.
 *
 * Two things about the resume path, both measured against 0.147.0 rather than assumed:
 *
 * - **`resume` refuses `-s` and `-C`.** The sandbox mode goes through `-c sandbox_mode` instead,
 *   and the working directory comes from the spawned process. Checked, not trusted: a resumed turn
 *   told to write to `~` answered *"Denied: operation not permitted"* and no file appeared.
 * - **`--ephemeral` is gone**, because its whole job is to stop the session being written to disk,
 *   which is the thing `resume` needs. What it used to buy — nothing persisting — is bought instead
 *   by `sessions.ts` deleting the thread file with the conversation that owns it.
 */
function args(dir: string, out: string, search: boolean, resume: string | null): string[] {
  const hardening = [
    // Close the holes the measurements found: `workspace-write` leaves both of these writable.
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', `sandbox_workspace_write.writable_roots=["${dir}"]`,
    '-c', `tools.web_search=${search ? 'true' : 'false'}`,
    // The user's own config is for the user's own interactive use, and must not widen what a web
    // page can drive. Authentication still comes from CODEX_HOME.
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--json',
    '-o', out,
  ]

  return resume === null
    ? ['exec', '-C', dir, '-s', 'workspace-write', ...hardening]
    : ['exec', 'resume', resume, '-c', 'sandbox_mode="workspace-write"', ...hardening]
}

function runCodex(
  bin: string,
  argv: string[],
  cwd: string,
  home: string | null,
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    // stdin closed: codex reads it for extra input, and an open one leaves it waiting.
    const child = spawn(bin, argv, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The one thing that keeps a prompt typed into a drawer from reaching the user's own skills,
      // rules and hooks. See `codex-home.ts` for why no flag can do this.
      env: home === null ? process.env : { ...process.env, CODEX_HOME: home },
    })
    let stderr = ''
    // A chunk is not a line: codex's JSONL arrives split wherever the pipe felt like splitting it.
    let pending = ''

    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const event = toEvent(line.trim())
        if (event !== null) onEvent(event)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))

    // SIGTERM, not SIGKILL: codex is given the chance to close its own session file cleanly, and
    // a half-written one is what the next resume would have to read.
    const stop = () => { child.kill('SIGTERM') }
    if (signal?.aborted === true) stop()
    else signal?.addEventListener('abort', stop, { once: true })
  })
}

/**
 * The workspace path, out of anything a person will read.
 *
 * A real answer came back as `[welcome.md](/var/folders/9z/…/inkstone-codex-0njdCA/welcome.md)` — a
 * link into a directory that is deleted seconds later, naming a temp path the reader has no use for
 * and no business seeing. The model cannot know the workspace is disposable, so it is fixed here.
 *
 * A markdown link collapses to its own text, because a link to a deleted directory is worse than no
 * link at all. A bare path becomes the note's name, which is what the reader calls it anyway.
 */
export function scrub(text: string, dir: string, file: string): string {
  if (!text.includes(dir)) return text
  const linked = text.replace(
    new RegExp(`\\[([^\\]]*)\\]\\(${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^)]*\\)`, 'g'),
    '$1',
  )
  return linked.split(`${dir}/`).join('').split(dir).join(file)
}

export async function run(
  request: RunRequest,
  deps: RunDeps = {},
  onEvent: (event: RunEvent) => void = () => {},
): Promise<RunResult> {
  // A caller with no workspace gets one for this turn only — the single-turn shape, and what the
  // tests use. A conversation passes its own, made and swept by `sessions.ts`.
  const owned = request.dir === undefined
  const dir = request.dir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-agent-'))
  const file = fileNameFor(request.title)
  const notePath = path.join(dir, file)
  const outPath = path.join(dir, '.answer')
  const resume = request.resume ?? null

  try {
    // Re-seeded every turn from what the reader is looking at. Between two turns they can accept a
    // proposal, type, or have the file change underneath; the model must work from the version on
    // their screen, not the one it last wrote.
    await fs.writeFile(notePath, request.note, 'utf8')
    const moved = request.since != null && request.since !== request.note

    const head = preamble(file, resume !== null, moved)
    const argv = [...args(dir, outPath, request.search === true, resume), `${head}${request.prompt}`]
    const home = await (deps.home ?? privateHome)()
    const spawnIt = deps.spawnCodex
      ?? ((a: string[], cwd: string, emit: (e: RunEvent) => void, sig?: AbortSignal) =>
        runCodex(deps.bin ?? 'codex', a, cwd, home, emit, sig))

    // Everything the model says passes through `scrub` on the way out, events included. The thread
    // id is caught here rather than forwarded: the browser holds no session id, by design.
    let thread: string | null = resume
    const clean = (event: RunEvent | { kind: 'thread'; id: string }) => {
      if (event.kind === 'thread') { thread = event.id; return }
      if (event.kind === 'said') return onEvent({ kind: 'said', text: scrub(event.text, dir, file) })
      if (event.kind === 'ran') return onEvent({ kind: 'ran', command: scrub(event.command, dir, file) })
      return onEvent(event)
    }
    const { code, stderr } = await spawnIt(argv, dir, clean as (e: RunEvent) => void, request.signal)

    const after = await fs.readFile(notePath, 'utf8').catch(() => null)
    const answer = scrub((await fs.readFile(outPath, 'utf8').catch(() => '')).trim(), dir, file)

    if (code !== 0 && after === request.note && answer === '') {
      // Nothing said and nothing changed: there is no result to report, so report the failure.
      return { ok: false, error: stderr.trim().split('\n').slice(-1)[0] || `codex exited ${code}` }
    }

    const changed = after !== null && after !== request.note
    return { ok: true, answer, text: changed ? after : null, changed, thread }
  } finally {
    // A workspace this made, this deletes. One it was handed belongs to the conversation, and is
    // swept when that ends — see `sessions.ts`.
    if (owned) await fs.rm(dir, { recursive: true, force: true })
  }
}
