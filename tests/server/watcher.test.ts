import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerEvent } from '../../src/shared/events.js'
import { VaultWatcher } from '../../src/server/watcher.js'

let root: string
let watcher: VaultWatcher
let events: ServerEvent[]

/** Poll-based wait: more reliable than a fixed sleep and does not waste time on fast machines. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('timed out waiting for condition')
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-watch-'))
  await fs.writeFile(path.join(root, 'a.md'), 'one\n')
  events = []
  watcher = new VaultWatcher({
    root,
    onEvent: (e) => events.push(e),
    debounceMs: 30,
    selfWriteWindowMs: 1000,
  })
  await watcher.start()
})

afterEach(async () => {
  await watcher.stop()
  await fs.rm(root, { recursive: true, force: true })
})

describe('VaultWatcher', () => {
  it('emits file-changed when a file is modified externally', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    await waitFor(() => events.some((e) => e.type === 'file-changed'))
    const evt = events.find((e) => e.type === 'file-changed')
    expect(evt).toMatchObject({ type: 'file-changed', path: 'a.md' })
  })

  it('emits file-removed and tree-changed when a file is deleted', async () => {
    await fs.rm(path.join(root, 'a.md'))
    await waitFor(() => events.some((e) => e.type === 'file-removed'))
    expect(events.map((e) => e.type)).toContain('tree-changed')
  })

  it('emits tree-changed when a new file is added', async () => {
    await fs.writeFile(path.join(root, 'b.md'), 'new\n')
    await waitFor(() => events.some((e) => e.type === 'tree-changed'))
  })

  it('markSelfWrite suppresses events produced by self-writes', async () => {
    watcher.markSelfWrite('a.md')
    await fs.writeFile(path.join(root, 'a.md'), 'self\n')
    await new Promise((r) => setTimeout(r, 300))
    expect(events.filter((e) => e.type === 'file-changed')).toHaveLength(0)
  })

  it('does not suppress after the suppression window expires', async () => {
    const shortWatcher = new VaultWatcher({
      root,
      onEvent: (e) => events.push(e),
      debounceMs: 30,
      selfWriteWindowMs: 50,
    })
    await shortWatcher.start()
    shortWatcher.markSelfWrite('a.md')
    await new Promise((r) => setTimeout(r, 120))
    await fs.writeFile(path.join(root, 'a.md'), 'later\n')
    await waitFor(() => events.some((e) => e.type === 'file-changed'))
    await shortWatcher.stop()
  })

  it('ignores paths starting with a dot', async () => {
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref\n')
    await new Promise((r) => setTimeout(r, 300))
    expect(events).toHaveLength(0)
  })
})

// Fix round 1 finding 3: selfWriteWindowMs is a pure time-window check keyed
// on path + timestamp; it cannot distinguish "a late echo of our own write"
// from "a coincidental external edit to the same path within the same window"
// — the latter is also swallowed. This is not a bug being fixed in this round
// (see the WatcherOptions.selfWriteWindowMs comment and the parked notes);
// this test pins the current behaviour so that any future change to this logic
// is deliberate, not an accidental regression.
describe('VaultWatcher known limitation: external edits within the self-write suppression window', () => {
  it('an external edit to the same path within the suppression window is also swallowed (not a self-write, but indistinguishable)', async () => {
    watcher.markSelfWrite('a.md')
    // This write is "external" — not the write that markSelfWrite intended to
    // suppress, but one that happens to land in the same window on the same
    // path, simulating a near-simultaneous external editor change.
    await fs.writeFile(path.join(root, 'a.md'), 'genuinely external, but same window\n')
    await new Promise((r) => setTimeout(r, 300))
    expect(events.filter((e) => e.type === 'file-changed')).toHaveLength(0)
  })
})

// Fix round 1 finding 2: #lastMtimes deduplication must be limited to the
// startup grace period; once that period ends, the map must never be consulted
// again. This test constructs two genuinely different writes whose mtime is
// forced identical via fs.utimes (simulating two writes landing on the same
// mtime tick on a low-precision filesystem or network drive), then asserts that
// both are broadcast after the grace period ends. If the dedup logic degrades
// to "always active", the second write would be silently dropped as a spurious
// platform replay and the test would fail.
describe('VaultWatcher mtime deduplication grace period', () => {
  it('after the grace period ends, two real writes with identical mtimes are both delivered', async () => {
    // Use a separate watcher with a very short grace period and stop the default
    // beforeEach watcher first, to prevent it from responding to the same fs
    // events on the same directory and polluting the assertions below.
    await watcher.stop()
    const localEvents: ServerEvent[] = []
    const shortWatcher = new VaultWatcher({
      root,
      onEvent: (e) => localEvents.push(e),
      debounceMs: 30,
      selfWriteWindowMs: 1000,
      startupDedupMs: 50,
    })
    await shortWatcher.start()
    // Wait for the grace period to fully expire; after this, identical mtimes
    // no longer trigger deduplication. The wait itself may overlap with the
    // platform-level startup settlement window (see #lastMtimes comment at the
    // top of the class), which can produce an extra event whose mtime is
    // unrelated to forcedMtime below — that is known noise unrelated to what
    // this test is verifying. All assertions below therefore filter by exact
    // mtimeMs match rather than relying on "exactly this many total events" or
    // "the Nth element in the array".
    await new Promise((r) => setTimeout(r, 150))

    const file = path.join(root, 'a.md')
    const forcedMtime = new Date(Date.now())
    const matchingForcedMtime = () =>
      localEvents.filter(
        (e): e is Extract<ServerEvent, { type: 'file-changed' }> =>
          e.type === 'file-changed' && e.mtimeMs === forcedMtime.getTime(),
      )

    await fs.writeFile(file, 'first\n')
    await fs.utimes(file, forcedMtime, forcedMtime)
    await waitFor(() => matchingForcedMtime().length >= 1)
    expect(matchingForcedMtime()[0]).toMatchObject({ path: 'a.md', mtimeMs: forcedMtime.getTime() })

    // Second genuine write, mtime forced identical to the first — if dedup were
    // permanently active, this event would be discarded as "same mtime as last
    // recorded" and the waitFor below would time out.
    await fs.writeFile(file, 'second\n')
    await fs.utimes(file, forcedMtime, forcedMtime)
    await waitFor(() => matchingForcedMtime().length >= 2)

    expect(matchingForcedMtime()).toHaveLength(2)

    await shortWatcher.stop()
  })
})
