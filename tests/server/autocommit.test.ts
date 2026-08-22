import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AutoCommit } from '../../src/server/autocommit.js'
import { broadcastGitStatus } from '../../src/server/git-broadcast.js'
import { VaultGit } from '../../src/server/git/index.js'
import type { WsHub } from '../../src/server/ws.js'

let root: string
let git: VaultGit
let clock: number

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-auto-'))
  const raw = simpleGit(root)
  await raw.init(['--initial-branch=main'])
  await raw.addConfig('user.email', 'test@example.com')
  await raw.addConfig('user.name', 'Test')
  await fs.writeFile(path.join(root, 'a.md'), 'one\n')
  await raw.add('.')
  await raw.commit('initial')
  git = new VaultGit(root)
  clock = 1_000_000
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function makeAuto(intervalMs = 1000) {
  return new AutoCommit({ git, intervalMs, now: () => clock })
}

async function commitCount(): Promise<number> {
  return (await simpleGit(root).log()).total
}

describe('AutoCommit.tick', () => {
  it('does not commit before the interval elapses', async () => {
    const auto = makeAuto()
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    clock += 500
    await auto.tick()
    expect(await commitCount()).toBe(1)
  })

  it('commits when the interval has elapsed and there are changes', async () => {
    const auto = makeAuto()
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    clock += 1500
    await auto.tick()
    expect(await commitCount()).toBe(2)
    const log = await simpleGit(root).log()
    expect(log.latest?.message).toMatch(/^autosave:/)
  })

  it('does not commit even when the interval has passed if there are no changes', async () => {
    const auto = makeAuto()
    clock += 10_000
    await auto.tick()
    expect(await commitCount()).toBe(1)
  })

  it('does not commit when notifyWrite was never called, even if the working tree is dirty', async () => {
    const auto = makeAuto()
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    clock += 10_000
    await auto.tick()
    expect(await commitCount()).toBe(1)
  })

  it('resets the timer after a commit so two consecutive ticks only produce one commit', async () => {
    const auto = makeAuto()
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    clock += 1500
    await auto.tick()
    clock += 100
    await auto.tick()
    expect(await commitCount()).toBe(2)
  })

  it('commit message contains the changed filename', async () => {
    const auto = makeAuto()
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    clock += 1500
    await auto.tick()
    expect((await simpleGit(root).log()).latest?.message).toContain('a.md')
  })
})

describe('AutoCommit.commitNow', () => {
  it('commits immediately regardless of the interval', async () => {
    const auto = makeAuto(999_999)
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    const result = await auto.commitNow('wip: before codex turn')
    expect(result).not.toBeNull()
    expect((await simpleGit(root).log()).latest?.message).toBe('wip: before codex turn')
  })

  it('returns null when there are no changes', async () => {
    const auto = makeAuto()
    expect(await auto.commitNow('nothing')).toBeNull()
  })

  it('clears the pending-commit flag after committing', async () => {
    const auto = makeAuto(1000)
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    await auto.commitNow('manual')
    clock += 5000
    await auto.tick()
    expect(await commitCount()).toBe(2)
  })
})

describe('AutoCommit error handling', () => {
  it('calls onError and does not throw when git fails', async () => {
    const errors: unknown[] = []
    const broken = new VaultGit(path.join(root, 'does-not-exist'))
    const auto = new AutoCommit({
      git: broken,
      intervalMs: 1,
      now: () => clock,
      onError: (e) => errors.push(e),
    })
    auto.notifyWrite()
    clock += 100
    await expect(auto.tick()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})

// Fix round 1 / Finding 2: commitNow must never return null just because a
// tick() happened to be mid-flight — a caller (a later phase snapshotting
// around an AI agent turn) can't tell that apart from "nothing changed", and
// a rollback built on a snapshot that was never actually taken restores the
// wrong state. commitNow now waits for whatever's running to finish, then
// always runs its own commit. GatedVaultGit lets a test pause a real
// VaultGit call at a precise, deterministic point (right before
// commitStaged's git-commit call) instead of guessing at real-clock timing.
class GatedVaultGit extends VaultGit {
  #gated = true
  #resumeCommit: (() => void) | null = null
  #resolveEntered!: () => void
  readonly commitStagedEntered: Promise<void>

  constructor(root: string) {
    super(root)
    this.commitStagedEntered = new Promise((resolve) => {
      this.#resolveEntered = resolve
    })
  }

  override async commitStaged(message: string): Promise<string> {
    if (this.#gated) {
      this.#gated = false
      this.#resolveEntered()
      await new Promise<void>((resolve) => {
        this.#resumeCommit = resolve
      })
    }
    return super.commitStaged(message)
  }

  resumeCommit(): void {
    this.#resumeCommit?.()
  }
}

describe('AutoCommit concurrency', () => {
  it('commitNow called while tick is in flight still performs a real commit rather than being displaced into null', async () => {
    const gated = new GatedVaultGit(root)
    const auto = new AutoCommit({ git: gated, intervalMs: 1000, now: () => clock })

    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    clock += 1500

    const tickPromise = auto.tick()
    // Wait until tick has staged a.md and is paused inside commitStaged — then
    // create the second change, ensuring it is not swept into tick's stageAll.
    await gated.commitStagedEntered

    await fs.writeFile(path.join(root, 'b.md'), 'new\n')
    const commitNowPromise = auto.commitNow('urgent snapshot')

    gated.resumeCommit()
    await tickPromise
    const result = await commitNowPromise

    expect(result).not.toBeNull()
    expect(result!.files).toEqual(['b.md'])
    // initial commit (beforeEach) + tick's a.md commit + commitNow's b.md commit
    expect(await commitCount()).toBe(3)
  })

  it('a failed commit does not poison the queue; the next call can still commit normally', async () => {
    const missing = path.join(root, 'not-yet-a-repo')
    const flaky = new VaultGit(missing)
    const errors: unknown[] = []
    const auto = new AutoCommit({
      git: flaky,
      intervalMs: 1000,
      now: () => clock,
      onError: (e) => errors.push(e),
    })

    // Directory does not exist yet: the first call must fail and be absorbed by onError.
    const first = await auto.commitNow('first')
    expect(first).toBeNull()
    expect(errors).toHaveLength(1)

    // "Fix" the environment: turn the directory into a real repository.
    await fs.mkdir(missing)
    const rawFlaky = simpleGit(missing)
    await rawFlaky.init(['--initial-branch=main'])
    await rawFlaky.addConfig('user.email', 'test@example.com')
    await rawFlaky.addConfig('user.name', 'Test')
    await fs.writeFile(path.join(missing, 'x.md'), 'x\n')

    // The second call on the same AutoCommit instance must still work — proving
    // the previous failure did not deadlock the internal queue chain.
    const second = await auto.commitNow('second')
    expect(second).not.toBeNull()
    expect(second!.files).toEqual(['x.md'])
  })
})

describe('broadcastGitStatus', () => {
  it('broadcasts git-status after an autocommit', async () => {
    const events: unknown[] = []
    // Minimal fake hub — only the broadcast method is needed for this test;
    // clientCount and registerRoute are never called.
    const hub = {
      broadcast: (e: unknown) => events.push(e),
      clientCount: 0,
      registerRoute() {},
    } as unknown as WsHub

    // Wire onCommit to call broadcastGitStatus and capture its promise so the
    // test can await it directly — broadcastGitStatus is async (git.status +
    // git.remoteInfo), and onCommit's void return means AutoCommit doesn't await
    // it internally.
    let broadcastDone: Promise<void> = Promise.resolve()
    const auto = new AutoCommit({
      git,
      intervalMs: 1000,
      now: () => clock,
    })
    auto.setOnCommit(() => {
      broadcastDone = broadcastGitStatus(git, hub)
    })

    await fs.writeFile(path.join(root, 'a.md'), 'broadcast test\n')
    auto.notifyWrite()
    clock += 1500
    await auto.tick()

    // Wait for broadcastGitStatus to finish its async git calls.
    await broadcastDone

    expect(events.some((e) => (e as { type?: string }).type === 'git-status')).toBe(true)

    // Assert the event payload shape matches the widened ServerEvent type.
    const ev = events.find((e) => (e as { type?: string }).type === 'git-status') as {
      type: string
      dirty: boolean
      branch: string
      hasRemote: boolean
      ahead: number
    }
    expect(ev).toMatchObject({
      type: 'git-status',
      dirty: false, // just committed, so clean
      branch: 'main',
      hasRemote: false, // temp repo has no remote
      ahead: 0,
    })
  })
})
