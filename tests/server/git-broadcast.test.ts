import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { broadcastGitStatus } from '../../src/server/git-broadcast.js'
import { VaultGit } from '../../src/server/git/index.js'
import type { WsHub } from '../../src/server/ws.js'

function makeHub() {
  const events: unknown[] = []
  const hub = {
    broadcast: (e: unknown) => events.push(e),
    clientCount: 0,
    registerRoute() {},
  } as unknown as WsHub
  return { hub, events }
}

describe('broadcastGitStatus — error path', () => {
  it('resolves (does not reject) when git.status() throws, and hub.broadcast is not called', async () => {
    const { hub, events } = makeHub()
    // Point at a non-existent directory — git.status() will reject.
    const brokenGit = new VaultGit(path.join(os.tmpdir(), 'inkstone-no-such-repo-' + Date.now()))

    await expect(broadcastGitStatus(brokenGit, hub)).resolves.toBeUndefined()
    expect(events).toHaveLength(0)
  })
})

describe('broadcastGitStatus — happy path', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-broadcast-'))
    const raw = simpleGit(root)
    await raw.init(['--initial-branch=main'])
    await raw.addConfig('user.email', 'test@example.com')
    await raw.addConfig('user.name', 'Test')
    await fs.writeFile(path.join(root, 'a.md'), 'hello\n')
    await raw.add('.')
    await raw.commit('initial')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('resolves and broadcasts a git-status event with the correct payload', async () => {
    const { hub, events } = makeHub()
    const git = new VaultGit(root)

    await expect(broadcastGitStatus(git, hub)).resolves.toBeUndefined()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'git-status',
      dirty: false,
      branch: 'main',
      hasRemote: false,
      ahead: 0,
    })
  })
})
