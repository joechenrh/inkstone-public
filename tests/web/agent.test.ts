import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as apiModule from '../../src/web/api/index.js'
import { parsePairing, run } from '../../src/web/agent/api.js'
import { collapse, countChanges, diffLines } from '../../src/web/agent/diff.js'
import {
  activeBackend,
  applyProposal,
  ask,
  chooseBackend,
  chosenBackend,
  connection,
  forgetPairing,
  pairing,
  proposal,
  proposalsByNote,
  refresh,
  runningNotes,
  setPairing,
  startOver,
  turns,
  turnsByNote,
} from '../../src/web/state/agent.js'
import { baseRev, content, dirty, modifiedAt } from '../../src/web/state/document.js'
import { currentPath } from '../../src/web/state/vault.js'

const writeFile = vi.spyOn(apiModule.backend, 'writeFile')

const PAIRING = '127.0.0.1:63735/EXAMPLEPAIRINGTOKEN000000'

beforeEach(() => {
  localStorage.clear()
  forgetPairing()
  chosenBackend.value = null
  turnsByNote.value = {}
  proposalsByNote.value = {}
  runningNotes.value = []
  currentPath.value = null
  content.value = ''
  dirty.value = false
  baseRev.value = null
  modifiedAt.value = null
  writeFile.mockReset()
  writeFile.mockResolvedValue({ rev: '2', modifiedAt: 2 })
})

/** A `/status` answer, and optionally a `/run` stream, without a binary anywhere. */
function agentThatSays(status: unknown, ndjson?: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input)
    if (url.endsWith('/status')) return Promise.resolve(Response.json(status))
    return Promise.resolve(new Response(ndjson ?? '', {
      headers: { 'content-type': 'application/x-ndjson' },
    }))
  })
}

const ready = {
  machine: "Joe's MacBook",
  backends: [{ id: 'codex', found: true, version: '0.147.0', path: '/opt/homebrew/bin/codex' }],
}

describe('the pairing string', () => {
  it('takes what the binary prints', () => {
    expect(parsePairing(PAIRING)).toEqual({
      host: '127.0.0.1:63735',
      token: 'EXAMPLEPAIRINGTOKEN000000',
    })
  })

  it('tolerates a scheme and surrounding whitespace, because both survive a copy', () => {
    expect(parsePairing(`  http://${PAIRING}\n`)?.host).toBe('127.0.0.1:63735')
  })

  it('refuses a host that is not this machine', () => {
    // A pasted string is a place to put somebody else's hostname, and accepting one would turn a
    // paste into "send my notes there". The binary only ever listens on loopback.
    expect(parsePairing('notes.example.com:63735/EXAMPLEPAIRINGTOKEN000000')).toBeNull()
    expect(parsePairing('192.168.1.9:63735/EXAMPLEPAIRINGTOKEN000000')).toBeNull()
    expect(parsePairing('127.0.0.1.evil.com:63735/EXAMPLEPAIRINGTOKEN000000')).toBeNull()
  })

  it('refuses half of one', () => {
    expect(parsePairing('127.0.0.1:63735')).toBeNull()
    expect(parsePairing('127.0.0.1:63735/short')).toBeNull()
    expect(parsePairing('')).toBeNull()
  })

  it('survives a reload', () => {
    expect(setPairing(PAIRING)).toBe(true)
    expect(localStorage.getItem('inkstone.agent.pairing')).toBe(PAIRING)
  })
})

describe('which backend a prompt goes to', () => {
  it('adopts the only one on the machine, so a single install needs no choosing', async () => {
    agentThatSays(ready)
    setPairing(PAIRING)
    await refresh()

    expect(chosenBackend.value).toBe('codex')
    expect(activeBackend()?.version).toBe('0.147.0')
  })

  it('picks nothing when there are two, rather than picking the first', async () => {
    agentThatSays({
      machine: 'Studio',
      backends: [
        { id: 'codex', found: true, version: '0.147.0', path: '/a' },
        { id: 'other', found: true, version: '2.1', path: '/b' },
      ],
    })
    setPairing(PAIRING)
    await refresh()

    // The person picks. Guessing between two is how a note ends up in a model nobody chose.
    expect(chosenBackend.value).toBeNull()
    expect(activeBackend()).toBeNull()
  })

  it('resolves a remembered backend that is not here to nothing, not to whatever is', async () => {
    agentThatSays(ready)
    chooseBackend('some-other-agent')
    setPairing(PAIRING)
    await refresh()

    expect(activeBackend()).toBeNull()
  })

  it('does not treat an uninstalled backend as available', async () => {
    agentThatSays({ machine: 'Studio', backends: [{ id: 'codex', found: false, version: null, path: null }] })
    setPairing(PAIRING)
    await refresh()

    // It stays in the list — "I do not run that" and "that is not installed" are different
    // sentences — but it is not something a prompt can be sent to.
    expect(connection.value).toMatchObject({ kind: 'ready' })
    expect(activeBackend()).toBeNull()
  })

  it('starts over when the backend changes', async () => {
    agentThatSays(ready)
    setPairing(PAIRING)
    await refresh()
    turnsByNote.value = { 'n.md': [{ prompt: 'old', backend: 'codex', events: [], askedAt: 0, result: null }] }
    proposalsByNote.value = { 'n.md': { before: 'a', after: 'b' } }

    chooseBackend('other')

    // A turn belongs to the backend that produced it; showing it under a different name would
    // misattribute it, and applying a proposal from one under the other is worse.
    expect(turnsByNote.value).toEqual({})
    expect(proposal()).toBeNull()
  })

  it('reads an older binary that answers without a list as nothing to run', async () => {
    agentThatSays({ agent: 'inkstone-agent' })
    setPairing(PAIRING)
    await refresh()

    expect(activeBackend()).toBeNull()
  })
})

describe('what the connection says went wrong', () => {
  it('separates a rejected token from nothing answering', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
    setPairing(PAIRING)
    await refresh()

    // The pairing string changes every time the binary starts, so this is the common failure and
    // needs its own sentence: "run it again and paste the new line", not "it is broken".
    expect(connection.value).toEqual({ kind: 'stale' })
  })

  it('does not answer about a pairing that has since been removed', async () => {
    let fail: (e: Error) => void = () => {}
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise((_, reject) => { fail = reject }))
    setPairing(PAIRING)
    const checking = refresh()

    forgetPairing()
    fail(new TypeError('Failed to fetch'))
    await checking

    // Removing the agent mid-check used to leave the panel stuck on "not answering" — the check
    // failed a moment later and wrote `offline` over the `unpaired` that Remove had just set.
    // Offline is the case that takes seconds to fail, so it was the one state it always happened in.
    expect(connection.value).toEqual({ kind: 'unpaired' })
  })

  it('reports a refused connection as offline rather than throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    setPairing(PAIRING)
    await refresh()

    expect(connection.value).toEqual({ kind: 'offline' })
  })
})

describe('a run', () => {
  const stream = [
    '{"kind":"said","text":"Looking at the note."}',
    '{"kind":"ran","command":"rg heading note.md"}',
    '{"kind":"result","ok":true,"answer":"Rewrote it.","text":"new\\n","changed":true}',
  ].join('\n') + '\n'

  async function readyAgent(ndjson?: string) {
    const fetchSpy = agentThatSays(ready, ndjson)
    setPairing(PAIRING)
    await refresh()
    currentPath.value = 'note.md'
    content.value = 'old\n'
    return fetchSpy
  }

  it('names the backend, the note, and what the note is called', async () => {
    const fetchSpy = await readyAgent(stream)
    await ask('Polish this')

    // `title` is what the reader calls this note. Without it the workspace file was always
    // `note.md`, and the model said so in its answers about a file called something else.
    // `search` is always true: there is no agent worth wiring up that cannot search the web, so
    // the toggle that used to sit here was a tax on every prompt.
    const body = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>
    expect(body).toEqual({
      backend: 'codex', note: 'old\n', prompt: 'Polish this', title: 'note.md', search: true,
    })
  })

  it('sends the buffer, not the disk', async () => {
    const fetchSpy = await readyAgent(stream)
    content.value = 'what the person is looking at\n'
    await ask('Explain this')

    const body = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body)) as { note: string }
    expect(body.note).toBe('what the person is looking at\n')
  })

  it('shows each event as it arrives rather than only the result', async () => {
    await readyAgent(stream)
    await ask('Polish this')

    expect(turns()[0]?.events.map((e) => e.kind)).toEqual(['said', 'ran'])
    expect(turns()[0]?.result).toMatchObject({ ok: true, answer: 'Rewrote it.' })
  })

  it('holds a rewrite as a proposal and writes nothing', async () => {
    await readyAgent(stream)
    await ask('Polish this')

    expect(proposal()).toEqual({ before: 'old\n', after: 'new\n', path: 'note.md' })
    // Nothing has been applied: the editor still holds what the person had.
    expect(content.value).toBe('old\n')
    expect(dirty.value).toBe(false)
  })

  it('offers no proposal when the note was left alone', async () => {
    await readyAgent('{"kind":"result","ok":true,"answer":"It is about X.","text":null,"changed":false}\n')
    await ask('What is this about?')

    expect(proposal()).toBeNull()
    expect(turns()[0]?.result).toMatchObject({ answer: 'It is about X.' })
  })

  it('reads events split across chunk boundaries', async () => {
    // A chunk can end mid-line. Splitting on every boundary drops whichever events arrived
    // fastest, which are exactly the ones a person is watching for.
    const parts = ['{"kind":"sa', 'id","text":"half"}\n{"kind":"result","ok":true,', '"answer":"a","text":null,"changed":false}\n']
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      new ReadableStream({
        start(c) {
          for (const p of parts) c.enqueue(new TextEncoder().encode(p))
          c.close()
        },
      }),
    ))

    const seen: string[] = []
    const result = await run(
      { host: '127.0.0.1:1', token: 'x'.repeat(20) },
      { backend: 'codex', note: 'n', prompt: 'p', title: 'n.md', search: true },
      (e) => seen.push(e.kind),
    )

    expect(seen).toEqual(['said'])
    expect(result).toMatchObject({ ok: true, answer: 'a' })
  })

  it('reports a stream that ends with no result as a failure, not an empty success', async () => {
    await readyAgent('{"kind":"said","text":"starting"}\n')
    await ask('Polish this')

    expect(turns()[0]?.result).toEqual({ ok: false, error: 'the agent stopped before it finished' })
  })
})

describe('a conversation per note', () => {
  const stream = (answer: string) =>
    `{"kind":"result","ok":true,"answer":${JSON.stringify(answer)},"text":null,"changed":false}\n`

  async function ready(ndjson: string) {
    const spy = agentThatSays(ready0, ndjson)
    setPairing(PAIRING)
    await refresh()
    return spy
  }
  const ready0 = {
    machine: "Joe's MacBook",
    backends: [{ id: 'codex', found: true, version: '0.147.0', path: '/a' }],
  }

  it('appends turns rather than replacing them', async () => {
    await ready(stream('first') + '')
    currentPath.value = 'a.md'
    content.value = 'x\n'

    await ask('one')
    await ask('two')

    // The model has seen the earlier turns now, so a transcript is honest where a single turn used
    // to be the only truthful thing to show.
    expect(turns().map((t) => t.prompt)).toEqual(['one', 'two'])
  })

  it('keeps each note\'s conversation, and shows the one in front of the reader', async () => {
    await ready(stream('answered'))
    content.value = 'x\n'

    currentPath.value = 'a.md'
    await ask('about a')
    currentPath.value = 'b.md'
    await ask('about b')

    expect(turns().map((t) => t.prompt)).toEqual(['about b'])
    currentPath.value = 'a.md'
    // Switching back brings the other one intact — nothing was abandoned and nothing confirmed.
    expect(turns().map((t) => t.prompt)).toEqual(['about a'])
  })

  it('sends the note as the session key and holds no id of its own', async () => {
    const spy = await ready(stream('answered'))
    currentPath.value = 'notes/a.md'
    content.value = 'x\n'
    await ask('hello')

    const body = JSON.parse(String(spy.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>
    expect(body.title).toBe('notes/a.md')
    // The binary keys its sessions on this. Nothing here holds a session id, so nothing here can
    // hold a stale one, one for an expired session, or one the binary forgot on restart.
    expect(Object.keys(body).sort()).toEqual(['backend', 'note', 'prompt', 'search', 'title'])
  })

  it('a run belongs to its note, not to the drawer', async () => {
    await ready(stream('answered'))
    content.value = 'x\n'
    currentPath.value = 'a.md'

    const inFlight = ask('slow one')
    currentPath.value = 'b.md'   // the reader looks at something else while it works
    await inFlight

    currentPath.value = 'a.md'
    // Leaving a note must not cost the run: the answer lands in that note's conversation.
    expect(turns()[0]?.result).toMatchObject({ ok: true, answer: 'answered' })
  })

  it('starting over clears the note it is on and asks the binary to end the session', async () => {
    const spy = await ready(stream('answered'))
    content.value = 'x\n'
    currentPath.value = 'a.md'
    await ask('one')
    currentPath.value = 'b.md'
    await ask('two')

    currentPath.value = 'a.md'
    await startOver()

    expect(turns()).toEqual([])
    const last = spy.mock.calls.at(-1)
    expect(last?.[1]?.method).toBe('DELETE')
    expect(JSON.parse(String(last?.[1]?.body))).toEqual({ title: 'a.md' })
    // And only that note's.
    currentPath.value = 'b.md'
    expect(turns().map((t) => t.prompt)).toEqual(['two'])
  })
})

describe('applying a proposal', () => {
  it('puts it in the buffer and saves it', async () => {
    currentPath.value = 'note.md'
    content.value = 'old\n'
    proposalsByNote.value = { 'note.md': { before: 'old\n', after: 'new\n' } }

    expect(applyProposal()).toBe('applied')
    expect(content.value).toBe('new\n')

    // Apply is already the deliberate act. Asking for Ctrl+S afterwards asks twice for one
    // decision, and the unsaved gap in between is where an agent's work is lost to a closed tab.
    await Promise.resolve()
    await vi.waitFor(() => { expect(writeFile).toHaveBeenCalledWith('note.md', 'new\n', undefined) })
  })

  it('saves nothing when it refuses', async () => {
    currentPath.value = 'note.md'
    content.value = 'old\n'
    proposalsByNote.value = { 'note.md': { before: 'old\n', after: 'new\n' } }
    content.value = 'the person kept typing\n'

    expect(applyProposal()).toBe('moved')
    await Promise.resolve()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('refuses when the note was edited while the agent worked', () => {
    currentPath.value = 'note.md'
    content.value = 'old\n'
    proposalsByNote.value = { 'note.md': { before: 'old\n', after: 'new\n' } }
    content.value = 'the person kept typing\n'

    // Applying here would silently drop whichever of the two happened second.
    expect(applyProposal()).toBe('moved')
    expect(content.value).toBe('the person kept typing\n')
  })

  it('refuses when a different note is open', () => {
    currentPath.value = 'other.md'
    content.value = 'old\n'
    proposalsByNote.value = { 'note.md': { before: 'old\n', after: 'new\n' } }

    expect(applyProposal()).toBe('moved')
    expect(content.value).toBe('old\n')
  })
})

describe('the diff a proposal is read through', () => {
  it('marks only what moved', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    expect(lines.map((l) => l.kind)).toEqual(['same', 'del', 'add', 'same', 'same'])
    expect(countChanges(lines)).toEqual({ added: 1, removed: 1 })
  })

  it('reads an appended section as additions rather than a rewrite', () => {
    // The common shape: "add a references section". A diff that says the whole note changed would
    // be technically true of nothing and useless to review.
    const before = 'title\n\nbody\n'
    const lines = diffLines(before, `${before}\n## References\n\n- a link\n`)
    expect(countChanges(lines)).toEqual({ added: 4, removed: 0 })
  })

  it('collapses long unchanged runs so a one-line change is one screen', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 20', 'line twenty')
    const rows = collapse(diffLines(before, after))

    expect(rows.filter((r) => r.kind === 'gap').length).toBe(2)
    expect(rows.length).toBeLessThan(12)
  })

  it('says nothing changed when nothing did', () => {
    expect(countChanges(diffLines('same\n', 'same\n'))).toEqual({ added: 0, removed: 0 })
  })
})
