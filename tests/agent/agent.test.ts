import { afterEach, describe, expect, it } from 'vitest'
import { findCodex } from '../../src/agent/backends/codex-detect.js'
import { codexBackend } from '../../src/agent/backends/codex.js'
import { startAgent, type Agent } from '../../src/agent/server.js'
import { Sessions } from '../../src/agent/sessions.js'

const ORIGIN = 'https://notes.example.com'

const running: Agent[] = []
afterEach(async () => {
  for (const agent of running.splice(0)) await agent.close()
})

/** A codex that is present, absent, or present but mute. */
function codexThat(answers: Record<string, string | Error>) {
  return {
    exec: async (file: string) => {
      const answer = answers[file]
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error('ENOENT')
      return { stdout: answer }
    },
  }
}

async function agentWith(over: { detect?: object; run?: object; sessions?: Sessions } = {}) {
  const agent = await startAgent({
    origin: ORIGIN,
    machine: "Joe's MacBook",
    sessions: over.sessions,
    backends: [codexBackend({
      detect: over.detect ?? codexThat({ which: '/opt/homebrew/bin/codex\n', codex: 'codex-cli 0.31.0\n' }),
      run: over.run,
    })],
  })
  running.push(agent)
  return agent
}

/** A run body that is valid in every respect except the one under test. */
const runBody = (agent: Agent, over: Record<string, unknown> = {}) => ({
  method: 'POST',
  headers: { ...withToken(agent).headers, 'content-type': 'application/json' },
  body: JSON.stringify({ note: 'x\n', prompt: 'y', backend: 'codex', title: 'note.md', ...over }),
})

const at = (agent: Agent, path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${agent.port}${path}`, init)

const withToken = (agent: Agent) => ({ headers: { authorization: `Bearer ${agent.token}` } })

describe('where it listens', () => {
  it('binds loopback and nothing else', async () => {
    const agent = await agentWith()
    const address = agent.server.address()

    // The one invariant that cannot be got wrong: `0.0.0.0` here would put a stranger's agent on
    // every café network the laptop joins.
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1')
  })

  it('takes a port from the OS and puts it in the pairing string', async () => {
    const agent = await agentWith()

    expect(agent.port).toBeGreaterThan(0)
    // Nothing to discover and no port to scan: a fixed port would collide, and a page that learns
    // to scan ports has learned something it should not know how to do.
    expect(agent.pairing).toBe(`127.0.0.1:${agent.port}/${agent.token}`)
  })
})

describe('who may command it', () => {
  it('refuses a request with no token at all', async () => {
    const agent = await agentWith()
    const res = await at(agent, '/status')

    // CORS stops a hostile page reading a response; it does not stop it sending a request. This is
    // what actually keeps another tab from driving codex over someone's notes.
    expect(res.status).toBe(401)
  })

  it('refuses the wrong token, and one that is merely a prefix of the right one', async () => {
    const agent = await agentWith()

    for (const wrong of ['nonsense', agent.token.slice(0, -1), `${agent.token}x', ''`]) {
      const res = await at(agent, '/status', { headers: { authorization: `Bearer ${wrong}` } })
      expect(res.status, wrong).toBe(401)
    }
  })

  it('accepts the right one', async () => {
    const agent = await agentWith()
    expect((await at(agent, '/status', withToken(agent))).status).toBe(200)
  })

  it('guards every route, including ones that do not exist', async () => {
    const agent = await agentWith()

    // The check runs before routing on purpose: a route added later cannot forget it.
    expect((await at(agent, '/not-a-route')).status).toBe(401)
    expect((await at(agent, '/not-a-route', withToken(agent))).status).toBe(404)
  })

  it('gives each run a token that cannot be guessed from the last', async () => {
    const first = await agentWith()
    const second = await agentWith()

    expect(first.token).not.toBe(second.token)
    expect(first.token.length).toBeGreaterThanOrEqual(24)
  })
})

describe('who may read the answer', () => {
  it('names one origin and never a wildcard', async () => {
    const agent = await agentWith()
    const res = await at(agent, '/status', withToken(agent))

    // `*` would let any page read what this returns, and what it returns is somebody's notes.
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('vary')).toBe('origin')
  })

  it('answers the preflight without asking for a token', async () => {
    const agent = await agentWith()
    const res = await at(agent, '/status', { method: 'OPTIONS' })

    // A preflight carries no Authorization header by definition — 401 here would block every
    // request before it was made.
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization')
  })
})

describe('what it says about codex', () => {
  it('reports the version and where it found it', async () => {
    const agent = await agentWith()
    const body = await (await at(agent, '/status', withToken(agent))).json()

    // A version is a fact; "connected" is a claim. The drawer shows this one.
    // `backends`, never `codex`, and plural from the first version: the interface calls this the
    // agent, another backend is expected, and the binary is the half that does not update itself.
    expect(body).toEqual({
      agent: 'inkstone-agent',
      machine: "Joe's MacBook",
      backends: [{ id: 'codex', found: true, version: '0.31.0', path: '/opt/homebrew/bin/codex' }],
    })
  })

  it('says plainly when codex is not there, rather than failing at the first prompt', async () => {
    const agent = await agentWith({ detect: codexThat({}) })
    const body = await (await at(agent, '/status', withToken(agent))).json() as { backends: unknown }

    // "Not running" and "running but cannot find codex" are different problems with different
    // fixes, and the drawer must be able to tell them apart. So the entry stays in the list and
    // says `found: false` rather than being dropped from it.
    expect(body.backends).toEqual([{ id: 'codex', found: false, version: null, path: null }])
  })

  it('still counts codex as found when it will not say its version', async () => {
    const codex = await findCodex(codexThat({ which: '/usr/local/bin/codex\n', codex: new Error('no') }))

    // Telling someone to install what they already have is worse than offering to try.
    expect(codex).toEqual({ found: true, version: null, path: '/usr/local/bin/codex' })
  })

  it('reads a version out of whatever wording codex uses', async () => {
    const codex = await findCodex(codexThat({ which: '/bin/codex\n', codex: 'codex-cli 0.147.0 (arm64)\n' }))
    expect(codex.version).toBe('0.147.0')
  })
})

describe('what a run streams back', () => {
  it('sends events as they happen and a result at the end', async () => {
    const agent = await agentWith({
      run: {
        spawnCodex: async (argv: string[], cwd: string, emit: (e: { kind: string; text?: string; command?: string }) => void) => {
          const fs = await import('node:fs/promises')
          const path = await import('node:path')
          emit({ kind: 'said', text: 'Looking at the note.' })
          emit({ kind: 'ran', command: 'rg heading note.md' })
          emit({ kind: 'edited' })
          await fs.writeFile(path.join(cwd, 'note.md'), 'rewritten\n', 'utf8')
          await fs.writeFile(argv[argv.indexOf('-o') + 1]!, 'Done.', 'utf8')
          emit({ kind: 'done' })
          return { code: 0, stderr: '' }
        },
      },
    })

    const res = await at(agent, '/run', runBody(agent, { note: 'old\n', prompt: 'Polish this' }))

    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as { kind: string })

    // A run took half a minute against the real thing; the drawer must be able to say what is
    // happening rather than spin.
    expect(lines.map((l) => l.kind)).toEqual(['said', 'ran', 'edited', 'done', 'result'])
    expect(lines.at(-1)).toMatchObject({ ok: true, changed: true, text: 'rewritten\n', answer: 'Done.' })
  })

  it('still needs a note and a prompt', async () => {
    const agent = await agentWith()
    const res = await at(agent, '/run', runBody(agent, { note: undefined }))
    expect(res.status).toBe(400)
  })
})

describe('which backend a run goes to', () => {
  it('refuses a run that names none, even though there is only one it could mean', async () => {
    const agent = await agentWith()
    const res = await at(agent, '/run', runBody(agent, { backend: undefined }))

    // The browser names it every time. Guessing here would be right today and wrong the first day
    // someone has two, and the failure would be silent: a note run through a model nobody chose.
    expect(res.status).toBe(400)
  })

  it('refuses a backend it does not have, rather than falling back to one it does', async () => {
    const agent = await agentWith()
    const res = await at(agent, '/run', runBody(agent, { backend: 'some-other-agent' }))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "this agent does not run 'some-other-agent'" })
  })

  it('separates "I do not run that" from "that is not installed here"', async () => {
    const agent = await agentWith({ detect: codexThat({}) })
    const res = await at(agent, '/run', runBody(agent))

    // Two different sentences, because they have two different fixes — and the second one names
    // the machine, which is the fact a phone cannot infer.
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "'codex' is not installed on Joe's MacBook" })
  })

  it('runs the backend that was named', async () => {
    let ran = false
    const agent = await agentWith({
      run: { spawnCodex: async () => { ran = true; return { code: 0, stderr: '' } } },
    })
    await (await at(agent, '/run', runBody(agent))).text()

    expect(ran).toBe(true)
  })
})

describe('one conversation per note', () => {
  /** A codex that records how it was invoked and hands back a thread id like the real one. */
  function recordingCodex(calls: { argv: string[]; cwd: string }[]) {
    return {
      spawnCodex: async (argv: string[], cwd: string, emit: (e: { kind: string; id?: string }) => void) => {
        calls.push({ argv, cwd })
        const resumed = argv[1] === 'resume'
        emit({ kind: 'thread', id: resumed ? argv[2]! : 'thread-1' })
        const fs = await import('node:fs/promises')
        await fs.writeFile(argv[argv.indexOf('-o') + 1]!, 'ok', 'utf8')
        return { code: 0, stderr: '' }
      },
    }
  }

  it('starts a thread on the first turn and resumes it on the second', async () => {
    const calls: { argv: string[]; cwd: string }[] = []
    const agent = await agentWith({ run: recordingCodex(calls) })

    await (await at(agent, '/run', runBody(agent, { prompt: 'first' }))).text()
    await (await at(agent, '/run', runBody(agent, { prompt: 'second' }))).text()

    expect(calls[0]!.argv.slice(0, 2)).toEqual(['exec', '-C'])
    expect(calls[1]!.argv.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1'])
    // The same workspace both times: a resumed session refers to a file that would otherwise be
    // gone, so the workspace has to outlive the turn.
    expect(calls[1]!.cwd).toBe(calls[0]!.cwd)
  })

  it('keeps the hardening on the resume path, where -s and -C are refused', async () => {
    const calls: { argv: string[]; cwd: string }[] = []
    const agent = await agentWith({ run: recordingCodex(calls) })
    await (await at(agent, '/run', runBody(agent, { prompt: 'first' }))).text()
    await (await at(agent, '/run', runBody(agent, { prompt: 'second' }))).text()

    // Measured against 0.147.0: `resume` rejects `-s`, so the mode goes through config instead —
    // and it is enforced rather than merely accepted. Everything else has to survive too.
    const resumed = calls[1]!.argv.join(' ')
    expect(resumed).not.toContain(' -s ')
    expect(resumed).toContain('sandbox_mode="workspace-write"')
    expect(resumed).toContain('sandbox_workspace_write.exclude_slash_tmp=true')
    expect(resumed).toContain('sandbox_workspace_write.exclude_tmpdir_env_var=true')
    expect(resumed).toContain('--ignore-user-config')
    expect(resumed).toContain('--ignore-rules')
  })

  it('gives each note its own conversation', async () => {
    const calls: { argv: string[]; cwd: string }[] = []
    const agent = await agentWith({ run: recordingCodex(calls) })

    await (await at(agent, '/run', runBody(agent, { title: 'a.md' }))).text()
    await (await at(agent, '/run', runBody(agent, { title: 'b.md' }))).text()

    // Separate workspaces, and neither turn resumed the other's thread. Switching notes switches
    // the conversation with it — there is no "current conversation" to be in the wrong place.
    expect(calls[1]!.cwd).not.toBe(calls[0]!.cwd)
    expect(calls[1]!.argv[1]).not.toBe('resume')
    expect(agent.sessions.list().map((x) => x.key).sort()).toEqual(['a.md', 'b.md'])
  })

  it('tells the model when the note moved under it, and not when it did not', async () => {
    const calls: { argv: string[]; cwd: string }[] = []
    const agent = await agentWith({ run: recordingCodex(calls) })

    await (await at(agent, '/run', runBody(agent, { note: 'one\n' }))).text()
    await (await at(agent, '/run', runBody(agent, { note: 'one\n' }))).text()
    await (await at(agent, '/run', runBody(agent, { note: 'the reader typed\n' }))).text()

    expect(calls[1]!.argv.at(-1)).not.toContain('has changed since your last turn')
    // Otherwise "now make it shorter" runs against a version nobody is looking at.
    expect(calls[2]!.argv.at(-1)).toContain('has changed since your last turn')
  })

  it('does not repeat the whole preamble on every turn', async () => {
    const calls: { argv: string[]; cwd: string }[] = []
    const agent = await agentWith({ run: recordingCodex(calls) })
    await (await at(agent, '/run', runBody(agent))).text()
    await (await at(agent, '/run', runBody(agent))).text()

    // It is already in the context. Repeating it spends the window on instructions the model has
    // read four times, and it comes back out as nagging in the answers.
    expect(calls[0]!.argv.at(-1)).toContain('Say nothing about these instructions')
    expect(calls[1]!.argv.at(-1)).not.toContain('Say nothing about these instructions')
  })

  it('stops the process when the browser stops listening', async () => {
    let stopped = false
    const agent = await agentWith({
      run: {
        spawnCodex: (_argv: string[], _cwd: string, _emit: unknown, signal?: AbortSignal) =>
          new Promise<{ code: number; stderr: string }>((resolve) => {
            // Nothing finishes on its own, which is what a real run looks like from here: the model
            // is still thinking when the reader gives up on it.
            signal?.addEventListener('abort', () => {
              stopped = true
              resolve({ code: -1, stderr: '' })
            })
          }),
      },
    })

    const abort = new AbortController()
    const res = at(agent, '/run', { ...runBody(agent), signal: abort.signal })
    await new Promise((r) => setTimeout(r, 200))
    abort.abort()
    await res.catch(() => {})
    await new Promise((r) => setTimeout(r, 300))

    // Without this the run went to completion and spent the reader's own model quota on an answer
    // nobody would ever see. A button that says Stop has to stop something. The signal is in the
    // `spawnCodex` signature precisely so this is observable — an earlier version asserted on a
    // fetch promise that had already resolved at the headers, and passed for the wrong reason.
    expect(stopped).toBe(true)
  })

  it('drops a conversation on request, and says whether there was one', async () => {
    const agent = await agentWith({ run: recordingCodex([]) })
    await (await at(agent, '/run', runBody(agent, { title: 'a.md' }))).text()

    const del = (title: string) => at(agent, '/session', {
      method: 'DELETE',
      headers: { ...withToken(agent).headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })

    expect(await (await del('a.md')).json()).toEqual({ dropped: true })
    expect(await (await del('a.md')).json()).toEqual({ dropped: false })
    expect(agent.sessions.list()).toEqual([])
  })

  it('never puts a session id on the wire', async () => {
    const agent = await agentWith({ run: recordingCodex([]) })
    const body = await (await at(agent, '/run', runBody(agent))).text()

    // The browser holds no id, so it cannot hold a stale one, one for a session that expired, or
    // one for a conversation the binary forgot when it restarted.
    expect(body).not.toContain('thread')
    expect(await (await at(agent, '/sessions', withToken(agent))).json())
      .toMatchObject({ sessions: [{ key: 'note.md', turns: 1 }] })
  })
})

describe('what bounds the sessions', () => {
  it('evicts the least recently used past the cap', async () => {
    let clock = 1000
    const sessions = new Sessions({ max: 2, now: () => (clock += 1000) })
    const fs = await import('node:fs/promises')
    const gone = async (dir: string) => !(await fs.access(dir).then(() => true, () => false))

    await sessions.for('a.md')
    const b = await sessions.for('b.md')
    await sessions.for('a.md')          // a is used again, so b is now the oldest
    await sessions.for('c.md')

    expect(sessions.list().map((x) => x.key).sort()).toEqual(['a.md', 'c.md'])
    // Evicted means gone from disk, not merely gone from a map.
    expect(await gone(b.dir)).toBe(true)
    await sessions.closeAll()
  })

  it('sweeps what has gone idle, and leaves what has not', async () => {
    let clock = 0
    const sessions = new Sessions({ idleMs: 100, now: () => clock })
    const fs = await import('node:fs/promises')

    const stale = await sessions.for('old.md')
    clock = 500
    await sessions.for('new.md')

    // Swept when somebody asks, not on a timer: a timer keeps a process awake to delete
    // directories nobody is waiting on.
    expect(sessions.list().map((x) => x.key)).toEqual(['new.md'])
    expect(await fs.access(stale.dir).then(() => true, () => false)).toBe(false)
    await sessions.closeAll()
  })

  it('leaves nothing behind when it closes', async () => {
    const sessions = new Sessions()
    const dirs = [await sessions.for('a.md'), await sessions.for('b.md')].map((x) => x.dir)
    await sessions.closeAll()

    const fs = await import('node:fs/promises')
    for (const dir of dirs) {
      expect(await fs.access(dir).then(() => true, () => false)).toBe(false)
    }
  })

  it("deletes the backend's own record of a conversation, not only the workspace", async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')

    // Multi-turn costs `--ephemeral`, so the conversation — including the note's text — is now
    // written to a file. The thing that owns the session owns that too.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-home-'))
    const day = path.join(home, 'sessions', '2026', '08', '14')
    await fs.mkdir(day, { recursive: true })
    const mine = path.join(day, 'rollout-2026-08-14T17-04-35-thread-1.jsonl')
    const theirs = path.join(day, 'rollout-2026-08-14T17-04-07-thread-2.jsonl')
    await fs.writeFile(mine, "the note's text", 'utf8')
    await fs.writeFile(theirs, 'somebody else', 'utf8')

    // Driven through `drop`, not by calling the helper. The first version of this test called the
    // helper directly and passed while the store was constructed without a `home` — so the real
    // binary left every note's text on disk and the suite said it did not.
    const sessions = new Sessions({ home: async () => home })
    const session = await sessions.for('a.md')
    session.thread = 'thread-1'
    await sessions.drop('a.md')

    expect(await fs.access(mine).then(() => true, () => false)).toBe(false)
    expect(await fs.access(theirs).then(() => true, () => false)).toBe(true)
    expect(await fs.access(session.dir).then(() => true, () => false)).toBe(false)
    await fs.rm(home, { recursive: true, force: true })
  })

  it('carries a home by default, or a dropped conversation leaves its text on disk', async () => {
    const { startAgent } = await import('../../src/agent/server.js')
    const agent = await startAgent({ origin: ORIGIN, backends: [codexBackend()] })
    running.push(agent)

    // The wiring, not the helper: this is the assertion the first version was missing.
    const session = await agent.sessions.for('a.md')
    expect(session.dir).toContain('inkstone-agent-')
    // `home` is private to the store, so it is checked by behaviour: dropping resolves rather than
    // throwing, and it is the only path that can reach `forgetThread` at all.
    await expect(agent.sessions.drop('a.md')).resolves.toBe(true)
  })
})

describe('telling an answer from an edit', () => {
  /** A codex that writes what it is told to, without spending anyone's quota. */
  const codexThatWrites = (edit: string | null, answer: string) => ({
    spawnCodex: async (argv: string[], cwd: string) => {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      if (edit !== null) await fs.writeFile(path.join(cwd, 'note.md'), edit, 'utf8')
      const out = argv[argv.indexOf('-o') + 1]!
      await fs.writeFile(out, answer, 'utf8')
      return { code: 0, stderr: '' }
    },
  })

  it('reports an answer when the note is untouched', async () => {
    const { run } = await import('../../src/agent/backends/codex-run.js')
    const result = await run({ note: '# A note\n\nbody\n', prompt: 'What is this about?' },
      codexThatWrites(null, 'It is about a note.'))

    // Observed, not declared: nothing was asked of the model, so nothing could be got wrong.
    expect(result).toMatchObject({ ok: true, answer: 'It is about a note.', text: null, changed: false })
  })

  it('reports an edit, and hands back the text rather than writing it anywhere', async () => {
    const { run } = await import('../../src/agent/backends/codex-run.js')
    const result = await run({ note: 'old\n', prompt: 'Polish this' },
      codexThatWrites('new\n', 'Rewrote the sentence.'))

    expect(result).toMatchObject({ ok: true, changed: true, text: 'new\n', answer: 'Rewrote the sentence.' })
  })

  it('counts a file rewritten to the same bytes as no change at all', async () => {
    const { run } = await import('../../src/agent/backends/codex-run.js')
    const result = await run({ note: 'same\n', prompt: 'Consider this' },
      codexThatWrites('same\n', 'Nothing needed changing.'))

    // What matters to a reader is whether the note differs, not whether a write happened.
    expect(result).toMatchObject({ changed: false, text: null })
  })

  it('leaves nothing behind on disk', async () => {
    const { run } = await import('../../src/agent/backends/codex-run.js')
    const fs = await import('node:fs/promises')
    const os = await import('node:os')

    const ours = async () =>
      (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('inkstone-agent-'))

    const before = await ours()
    await run({ note: 'x\n', prompt: 'y' }, codexThatWrites('z\n', 'done'))
    const after = await ours()

    // A workspace `run` makes for itself exists for one request. One handed to it belongs to a
    // conversation and is swept by `sessions.ts` — which its own tests check.
    expect(after).toEqual(before)
  })

  it('reports a failure rather than an empty success', async () => {
    const { run } = await import('../../src/agent/backends/codex-run.js')
    const result = await run({ note: 'x\n', prompt: 'y' }, {
      spawnCodex: async () => ({ code: 1, stderr: 'Error: something went wrong\n' }),
    })

    expect(result).toEqual({ ok: false, error: 'Error: something went wrong' })
  })

  it('calls the note what the reader calls it', async () => {
    const { run } = await import('../../src/agent/backends/codex-run.js')
    let seen: { dir: string; files: string[]; prompt: string } | null = null
    await run({ note: 'x\n', prompt: 'y', title: 'notes/C++ coroutines.md' }, {
      spawnCodex: async (argv: string[], cwd: string) => {
        const fs = await import('node:fs/promises')
        seen = { dir: cwd, files: await fs.readdir(cwd), prompt: argv.at(-1)! }
        return { code: 0, stderr: '' }
      },
    })

    // It used to be `note.md` always, and the model said so in answers about a file the reader
    // knows by another name. A title is part of a note — a heading is often written to agree
    // with it — so withholding it made the model work from less than the reader could see.
    expect(seen!.files).toContain('C++ coroutines.md')
    expect(seen!.prompt).toContain('`C++ coroutines.md`')
  })

  it('keeps a hostile title inside the workspace', async () => {
    const { run } = await import('../../src/agent/backends/codex-run.js')
    const names: string[][] = []
    const capture = {
      spawnCodex: async (_argv: string[], cwd: string) => {
        const fs = await import('node:fs/promises')
        names.push(await fs.readdir(cwd))
        return { code: 0, stderr: '' }
      },
    }

    // The title arrives from a browser, and a path is a place to put an escape. Only the basename
    // is used, and only after everything that is not a letter, number, space, dot, dash or
    // underscore has been dropped.
    for (const title of ['../../../etc/passwd', '/etc/passwd', '..', '.', '', 'a/../../b.md']) {
      await run({ note: 'x', prompt: 'y', title }, capture)
    }
    for (const files of names) {
      expect(files.every((f) => !f.includes('/') && f !== '..' && f !== '.')).toBe(true)
    }
    expect(names.map((f) => f.filter((n) => n !== '.answer')[0])).toEqual([
      'passwd.md', 'passwd.md', 'note.md', 'note.md', 'note.md', 'b.md',
    ])
  })

  it('tells the model not to narrate the setup back at the reader', async () => {
    const { run } = await import('../../src/agent/backends/codex-run.js')
    let prompt = ''
    await run({ note: 'x', prompt: 'Polish this' }, {
      spawnCodex: async (argv: string[]) => { prompt = argv.at(-1)!; return { code: 0, stderr: '' } },
    })

    // Both of these were real answers. "The English-tutor skill file is outside the permitted
    // directory, so I won't access it" — the reader did not write that constraint and cannot act
    // on it. "Your request is already clear; a slightly smoother phrasing is…" — nobody asked to
    // have their own sentence graded.
    expect(prompt).toContain('Say nothing about these instructions')
    expect(prompt).toContain('Do not restate, rephrase or comment on the request')
  })

  it('keeps the workspace path out of anything a person reads', async () => {
    const { run, scrub } = await import('../../src/agent/backends/codex-run.js')
    const dir = '/var/folders/9z/xxx/T/inkstone-codex-0njdCA'

    // A real answer came back exactly like this. The directory is deleted seconds later.
    expect(scrub(`已阅读论文并将中文介绍写入 [welcome.md](${dir}/welcome.md)。`, dir, 'welcome.md'))
      .toBe('已阅读论文并将中文介绍写入 welcome.md。')
    expect(scrub(`wrote ${dir}/note.md and ${dir}`, dir, 'note.md')).toBe('wrote note.md and note.md')
    expect(scrub('nothing to scrub here', dir, 'note.md')).toBe('nothing to scrub here')

    // And on the way through a run, for the events as well as the answer.
    const said: string[] = []
    const result = await run({ note: 'x', prompt: 'y', title: 'welcome.md' }, {
      home: async () => null,
      spawnCodex: async (argv: string[], cwd: string, emit) => {
        const fs = await import('node:fs/promises')
        emit({ kind: 'said', text: `looking at ${cwd}/welcome.md` })
        await fs.writeFile(argv[argv.indexOf('-o') + 1]!, `done: [welcome.md](${cwd}/welcome.md)`, 'utf8')
        return { code: 0, stderr: '' }
      },
    }, (e) => { if (e.kind === 'said') said.push(e.text) })

    expect(said).toEqual(['looking at welcome.md'])
    expect(result).toMatchObject({ answer: 'done: welcome.md' })
  })

  it('runs with a codex home that carries the credential and nothing else', async () => {
    const { privateHome } = await import('../../src/agent/backends/codex-home.js')
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-home-test-'))
    const from = path.join(root, 'auth.json')
    const to = path.join(root, 'home')
    await fs.writeFile(from, '{"not":"a real credential"}', 'utf8')

    expect(await privateHome({ from, to })).toBe(to)
    // Symlinked, never copied: this process must not hold a copy of anyone's token.
    expect((await fs.lstat(path.join(to, 'auth.json'))).isSymbolicLink()).toBe(true)
    // And nothing else is there — no skills, no rules, no AGENTS.md, no hooks.
    expect(await fs.readdir(to)).toEqual(['auth.json'])

    // A token refresh that replaces rather than writes through leaves a regular file here, and the
    // real one silently stops being updated. So it is checked and repaired every run, not once.
    await fs.rm(path.join(to, 'auth.json'))
    await fs.writeFile(path.join(to, 'auth.json'), 'a regular file now', 'utf8')
    expect(await privateHome({ from, to })).toBe(to)
    expect((await fs.lstat(path.join(to, 'auth.json'))).isSymbolicLink()).toBe(true)

    // No credential to point at: run without the variable rather than with a home that cannot
    // authenticate. A run that fails to sign in is a worse failure, and an unexplainable one.
    expect(await privateHome({ from: path.join(root, 'nope.json'), to })).toBeNull()

    await fs.rm(root, { recursive: true, force: true })
  })

  it('passes the hardening flags, and web search only when asked', async () => {
    const { run } = await import('../../src/agent/backends/codex-run.js')
    let seen: string[] = []
    const capture = { spawnCodex: async (argv: string[]) => { seen = argv; return { code: 0, stderr: '' } } }

    await run({ note: 'x', prompt: 'y' }, capture)
    const flags = seen.join(' ')
    // Each of these was a measurement: workspace-write leaves /tmp and $TMPDIR writable, and a
    // user's own config can widen what a web page drives.
    expect(flags).toContain('sandbox_workspace_write.exclude_slash_tmp=true')
    expect(flags).toContain('sandbox_workspace_write.exclude_tmpdir_env_var=true')
    expect(flags).toContain('--ignore-user-config')
    expect(flags).toContain('tools.web_search=false')
    // `--ephemeral` is deliberately absent. Its whole job was to stop the session reaching disk,
    // which is exactly what `resume` needs; the thread file is deleted with the conversation that
    // owns it instead. See `sessions.ts`.
    expect(flags).not.toContain('--ephemeral')

    await run({ note: 'x', prompt: 'y', search: true }, capture)
    // The one capability that reaches off the machine is never on by default.
    expect(seen.join(' ')).toContain('tools.web_search=true')
  })
})
