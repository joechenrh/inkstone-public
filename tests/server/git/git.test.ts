import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitError, simpleGit } from 'simple-git'
import { VaultGit, VaultGitError } from '../../../src/server/git/index.js'

async function gitDirOf(dir: string): Promise<string> {
  return (await simpleGit(dir).raw(['rev-parse', '--absolute-git-dir'])).trim()
}

async function fileExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

let root: string
let git: VaultGit

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-git-'))
  const raw = simpleGit(root)
  await raw.init(['--initial-branch=main'])
  await raw.addConfig('user.email', 'test@example.com')
  await raw.addConfig('user.name', 'Test')
  await fs.writeFile(path.join(root, 'a.md'), 'one\n')
  await raw.add('.')
  await raw.commit('initial')
  git = new VaultGit(root)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('isRepo', () => {
  it('returns true for a git repository', async () => {
    expect(await git.isRepo()).toBe(true)
  })

  it('returns false for a non-repository directory', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-plain-'))
    expect(await new VaultGit(plain).isRepo()).toBe(false)
    await fs.rm(plain, { recursive: true, force: true })
  })
})

describe('status', () => {
  it('dirty is false and the branch name is present when the tree is clean', async () => {
    const s = await git.status()
    expect(s.dirty).toBe(false)
    expect(s.branch).toBe('main')
  })

  it('dirty is true when there are untracked files', async () => {
    await fs.writeFile(path.join(root, 'b.md'), 'two\n')
    expect((await git.status()).dirty).toBe(true)
  })

  it('dirty is true when there are modified files', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'changed\n')
    expect((await git.status()).dirty).toBe(true)
  })
})

describe('commitAll', () => {
  it('commits all changes and returns sha and file list', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'changed\n')
    await fs.writeFile(path.join(root, 'b.md'), 'two\n')
    const result = await git.commitAll('test: change two files')
    expect(result).not.toBeNull()
    expect(result!.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(result!.files.sort()).toEqual(['a.md', 'b.md'])
    expect((await git.status()).dirty).toBe(false)
  })

  it('returns null and does not produce an empty commit when there are no changes', async () => {
    const before = await simpleGit(root).log()
    expect(await git.commitAll('noop')).toBeNull()
    const after = await simpleGit(root).log()
    expect(after.total).toBe(before.total)
  })

  it('commits a deleted file', async () => {
    await fs.rm(path.join(root, 'a.md'))
    const result = await git.commitAll('test: delete')
    expect(result!.files).toEqual(['a.md'])
  })
})

describe('diffOfCommit / revertCommit', () => {
  it('diff contains the changed content', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'changed\n')
    const result = await git.commitAll('test: change')
    const diff = await git.diffOfCommit(result!.sha)
    expect(diff).toContain('-one')
    expect(diff).toContain('+changed')
  })

  it('revert undoes the commit content', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'changed\n')
    const result = await git.commitAll('test: change')
    await git.revertCommit(result!.sha)
    expect(await fs.readFile(path.join(root, 'a.md'), 'utf8')).toBe('one\n')
  })

  it('diff of the root commit (no parent) shows added content instead of erroring', async () => {
    const log = await simpleGit(root).log()
    const rootSha = log.all[log.all.length - 1]!.hash
    const diff = await git.diffOfCommit(rootSha)
    expect(diff).toContain('+one')
  })
})

// simple-git surfaces raw git stderr, which for a concurrent-process
// index.lock failure embeds the repo's absolute filesystem path (verified by
// direct probing against real temp repos). commitAll and revertCommit both
// touch .git/index, so both must translate that into a path-free error —
// per the project-wide rule (see paths.ts, vault/index.ts) that no error
// leaving a server module may carry an absolute server path.
describe('error wrapping: concurrent git process (index.lock)', () => {
  it('commitAll throws VaultGitError on index.lock and the message does not contain the repo absolute path', async () => {
    await fs.writeFile(path.join(root, 'b.md'), 'two\n')
    await fs.writeFile(path.join(root, '.git', 'index.lock'), '')

    let caught: unknown
    try {
      await git.commitAll('should not commit')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(VaultGitError)
    expect((caught as Error).message).not.toContain(root)
    expect((caught as Error).cause).toBeDefined()

    await fs.rm(path.join(root, '.git', 'index.lock'))
  })

  it('revertCommit throws VaultGitError on index.lock and the message does not contain the repo absolute path', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'changed\n')
    const result = await git.commitAll('test: change')
    await fs.writeFile(path.join(root, '.git', 'index.lock'), '')

    let caught: unknown
    try {
      await git.revertCommit(result!.sha)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(VaultGitError)
    expect((caught as Error).message).not.toContain(root)
    expect((caught as Error).cause).toBeDefined()

    await fs.rm(path.join(root, '.git', 'index.lock'))
  })
})

// A conflicting revert must never leave the vault worse off than before the
// call: no leftover REVERT_HEAD, no conflict markers written into the
// user's notes, and the working tree byte-identical to its pre-attempt
// state. This module sits under an autosave loop, so anything left
// half-applied here gets silently committed by the next autosave tick.
describe('revertCommit: conflicting revert leaves the repository untouched', () => {
  it('a conflicting revert is rejected and both repo state and file content are restored to what they were before the attempt', async () => {
    // c1 (from beforeEach, a.md = "one") -> c2 (a.md = "two") -> c3 (a.md = "three").
    // Reverting c2 expects to find "two" and put back "one", but HEAD has
    // moved on to "three" on the same line, so the revert conflicts.
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    const c2 = await git.commitAll('c2')
    await fs.writeFile(path.join(root, 'a.md'), 'three\n')
    await git.commitAll('c3')

    const contentBefore = await fs.readFile(path.join(root, 'a.md'), 'utf8')
    const statusBefore = await git.status()

    let caught: unknown
    try {
      await git.revertCommit(c2!.sha)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(VaultGitError)

    const gitDir = await gitDirOf(root)
    expect(await fileExists(path.join(gitDir, 'REVERT_HEAD'))).toBe(false)

    const contentAfter = await fs.readFile(path.join(root, 'a.md'), 'utf8')
    expect(contentAfter).toBe(contentBefore)
    expect(contentAfter).not.toMatch(/<{7}|={7}|>{7}/)

    expect(await git.status()).toEqual(statusBefore)
  })
})

// Defense in depth for the same hazard: even if nothing in this process ever
// called revertCommit, a REVERT_HEAD/MERGE_HEAD/CHERRY_PICK_HEAD left behind
// by something else (the user's own terminal, a crashed process) must stop
// the autosave loop from committing — returning null here would read as
// "nothing to commit" and hide that the working tree may be mid-conflict.
describe('commitAll: refuses while a git operation is in progress', () => {
  it('refuses to commit when REVERT_HEAD is present, rather than returning null or committing silently', async () => {
    const gitDir = await gitDirOf(root)
    await fs.writeFile(path.join(gitDir, 'REVERT_HEAD'), `${'a'.repeat(40)}\n`)
    await fs.writeFile(path.join(root, 'b.md'), 'two\n')

    const before = await simpleGit(root).log()

    let caught: unknown
    try {
      await git.commitAll('should be refused')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(VaultGitError)

    const after = await simpleGit(root).log()
    expect(after.total).toBe(before.total)

    await fs.rm(path.join(gitDir, 'REVERT_HEAD'))
  })

  // Fix round 1 / Finding 1: the mid-revert guard used to live only in
  // stageAll(), on the theory that every caller reaches commitStaged() via
  // stageAll() first. AutoCommit (Task 8) does exactly that, but the two
  // calls are not atomic — nothing stops a future caller from calling
  // commitStaged() directly (or from stageAll()'s own guard becoming stale
  // relative to commitStaged()'s, since a revert can start in the gap
  // between them). The only thing protecting commitStaged() on its own was
  // a doc comment. This pins that commitStaged() enforces the same refusal
  // itself, independent of whatever stageAll() did or didn't check.
  it('commitStaged called in isolation also refuses when REVERT_HEAD is present', async () => {
    const gitDir = await gitDirOf(root)
    await fs.writeFile(path.join(gitDir, 'REVERT_HEAD'), `${'a'.repeat(40)}\n`)

    const before = await simpleGit(root).log()

    let caught: unknown
    try {
      await git.commitStaged('should be refused')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(VaultGitError)

    const after = await simpleGit(root).log()
    expect(after.total).toBe(before.total)

    await fs.rm(path.join(gitDir, 'REVERT_HEAD'))
  })
})

async function makeRepoWithRemote() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ink-remote-'))
  const bare = path.join(base, 'bare.git')
  const work = path.join(base, 'work')
  await simpleGit().init(['--bare', bare])
  const g = simpleGit()
  await g.init([work, '--initial-branch=main'] as never).catch(async () => {
    await fs.mkdir(work, { recursive: true }); await simpleGit(work).init(['--initial-branch=main'])
  })
  const wg = simpleGit(work)
  await wg.addConfig('user.email', 't@e.com'); await wg.addConfig('user.name', 't')
  await fs.writeFile(path.join(work, 'a.md'), 'one\n')
  await wg.add('.'); await wg.commit('init')
  await wg.addRemote('origin', bare); await wg.push(['-u', 'origin', 'main'])
  return { base, bare, work }
}

describe('VaultGit.remoteInfo', () => {
  it('returns null when there is no remote', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ink-noremote-'))
    const g = simpleGit(dir); await g.init(['--initial-branch=main'])
    await g.addConfig('user.email', 't@e.com'); await g.addConfig('user.name', 't')
    await fs.writeFile(path.join(dir, 'a.md'), 'x'); await g.add('.'); await g.commit('c')
    expect(await new VaultGit(dir).remoteInfo()).toBeNull()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('ahead=0 when there is an upstream and local is not ahead', async () => {
    const { base, work } = await makeRepoWithRemote()
    const info = await new VaultGit(work).remoteInfo()
    expect(info).toEqual({ name: 'origin', branch: 'main', ahead: 0 })
    await fs.rm(base, { recursive: true, force: true })
  })

  it('ahead=N when local is N commits ahead', async () => {
    const { base, work } = await makeRepoWithRemote()
    await fs.appendFile(path.join(work, 'a.md'), 'two\n')
    const wg = simpleGit(work); await wg.add('.'); await wg.commit('c2')
    expect((await new VaultGit(work).remoteInfo())?.ahead).toBe(1)
    await fs.rm(base, { recursive: true, force: true })
  })
})

describe('VaultGit.push', () => {
  it('pushes the ahead commits and returns the pushed count', async () => {
    const { base, bare, work } = await makeRepoWithRemote()
    await fs.appendFile(path.join(work, 'a.md'), 'two\n')
    const wg = simpleGit(work); await wg.add('.'); await wg.commit('c2')
    const res = await new VaultGit(work).push()
    expect(res.pushed).toBe(1)
    // bare repo should now contain that commit
    expect((await simpleGit(bare).raw(['log', '--oneline'])).trim()).toContain('c2')
    await fs.rm(base, { recursive: true, force: true })
  })

  it('throws VaultGitError when there is no upstream; message does not contain an absolute path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ink-noup-'))
    const g = simpleGit(dir); await g.init(['--initial-branch=main'])
    await g.addConfig('user.email', 't@e.com'); await g.addConfig('user.name', 't')
    await fs.writeFile(path.join(dir, 'a.md'), 'x'); await g.add('.'); await g.commit('c')
    let err: unknown
    try { await new VaultGit(dir).push() } catch (e) { err = e }
    expect(err).toBeInstanceOf(VaultGitError)
    expect((err as Error).message).not.toContain(dir)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('throws VaultGitError on a non-fast-forward push', async () => {
    const { base, bare, work } = await makeRepoWithRemote()
    // A second clone pushes a commit, making work fall behind → work's commit then becomes non-fast-forward
    const work2 = path.join(base, 'work2')
    await simpleGit().clone(bare, work2)
    const w2 = simpleGit(work2); await w2.addConfig('user.email','t@e.com'); await w2.addConfig('user.name','t')
    await fs.appendFile(path.join(work2, 'a.md'), 'from2\n'); await w2.add('.'); await w2.commit('c2'); await w2.push()
    await fs.appendFile(path.join(work, 'a.md'), 'from1\n')
    const wg = simpleGit(work); await wg.add('.'); await wg.commit('c1-local')
    let err: unknown
    try { await new VaultGit(work).push() } catch (e) { err = e }
    expect(err).toBeInstanceOf(VaultGitError)
    await fs.rm(base, { recursive: true, force: true })
  })
})

// simple-git's own GitError is third-party and out of our control, same as
// Node's fs errno strings — the reason Vault's guardFs wraps every errno,
// enumerated or not. Neither of these two scenarios currently leaks an
// absolute path (verified by direct probing), but a raw GitError must still
// never be the type a caller has to catch: a later task mapping failures to
// HTTP responses should only ever see one error taxonomy from this module.
describe('error wrapping: every method rejects VaultGitError, never raw GitError', () => {
  it('calling status() on a non-repository directory throws VaultGitError not GitError', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-plain-status-'))
    const plainGit = new VaultGit(plain)

    let caught: unknown
    try {
      await plainGit.status()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(VaultGitError)
    expect(caught).not.toBeInstanceOf(GitError)

    await fs.rm(plain, { recursive: true, force: true })
  })

  it('calling diffOfCommit() with a bad sha throws VaultGitError not GitError', async () => {
    const badSha = 'deadbeef' + '0'.repeat(32)

    let caught: unknown
    try {
      await git.diffOfCommit(badSha)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(VaultGitError)
    expect(caught).not.toBeInstanceOf(GitError)
  })
})

describe('logForFile', () => {
  it('lists only the commits that touched the file, newest first, with line counts', async () => {
    const raw = simpleGit(root)
    await fs.writeFile(path.join(root, 'b.md'), 'other\n')
    await raw.add('.')
    await raw.commit('touches b only')

    await fs.writeFile(path.join(root, 'a.md'), 'one\ntwo\nthree\n')
    await raw.add('.')
    await raw.commit('autosave: a.md')

    const log = await git.logForFile('a.md', 20)
    expect(log.map((c) => c.message)).toEqual(['autosave: a.md', 'initial'])
    expect(log[0]).toMatchObject({ added: 2, removed: 0 })
    // The root commit counts the whole file as added.
    expect(log[1]).toMatchObject({ added: 1, removed: 0 })
    expect(log[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('honours the limit and returns nothing for a file git has never seen', async () => {
    const raw = simpleGit(root)
    for (const n of ['two', 'three', 'four']) {
      await fs.writeFile(path.join(root, 'a.md'), `${n}\n`)
      await raw.add('.')
      await raw.commit(`autosave: a.md ${n}`)
    }
    expect(await git.logForFile('a.md', 2)).toHaveLength(2)
    expect(await git.logForFile('never-existed.md', 10)).toEqual([])
  })

  it('counts a removal as removed rather than added', async () => {
    const raw = simpleGit(root)
    await fs.writeFile(path.join(root, 'a.md'), 'one\ntwo\n')
    await raw.add('.')
    await raw.commit('grow')
    await fs.writeFile(path.join(root, 'a.md'), 'one\n')
    await raw.add('.')
    await raw.commit('shrink')
    const [latest] = await git.logForFile('a.md', 5)
    expect(latest).toMatchObject({ added: 0, removed: 1 })
  })
})

describe('diffFileRange', () => {
  it('collapses a run of commits into one diff for the file', async () => {
    const raw = simpleGit(root)
    const shas: string[] = []
    for (const n of ['two', 'three', 'four']) {
      await fs.writeFile(path.join(root, 'a.md'), `one\n${n}\n`)
      await fs.writeFile(path.join(root, 'noise.md'), `${n}\n`)
      await raw.add('.')
      shas.push((await raw.commit(`autosave ${n}`)).commit)
    }
    const log = await git.logForFile('a.md', 10)
    const oldest = log[log.length - 1]!.sha            // the "initial" commit
    const newest = log[0]!.sha

    const diff = await git.diffFileRange(oldest, newest, 'a.md')
    expect(diff).toContain('+four')
    // The intermediate states never appear, and neither does the other file.
    expect(diff).not.toContain('+two')
    expect(diff).not.toContain('noise.md')
  })

  it('diffs against the empty tree when there is nothing before the range', async () => {
    const [first] = await git.logForFile('a.md', 10)
    const diff = await git.diffFileRange(null, first!.sha, 'a.md')
    expect(diff).toContain('+one')
  })
})

describe('fileAtCommit', () => {
  it('returns the content the file had at that commit', async () => {
    const raw = simpleGit(root)
    await fs.writeFile(path.join(root, 'a.md'), 'rewritten\n')
    await raw.add('.')
    await raw.commit('rewrite')

    const log = await git.logForFile('a.md', 10)
    expect(await git.fileAtCommit(log[1]!.sha, 'a.md')).toBe('one\n')
    expect(await git.fileAtCommit(log[0]!.sha, 'a.md')).toBe('rewritten\n')
    // Reading an old version must not touch the working tree.
    expect(await fs.readFile(path.join(root, 'a.md'), 'utf8')).toBe('rewritten\n')
  })

  it('rejects with a VaultGitError for a path the commit does not contain', async () => {
    const [head] = await git.logForFile('a.md', 1)
    await expect(git.fileAtCommit(head!.sha, 'missing.md')).rejects.toBeInstanceOf(VaultGitError)
  })
})
