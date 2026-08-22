import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitHubBackend } from '../../../../src/web/api/github/backend.js'
import { fakeGitHub, fakeSha, type FakeRepo } from './fake-github.js'

beforeEach(() => { localStorage.clear() })

function backendFor(repo: FakeRepo, opts: { now?: () => number } = {}) {
  const github = fakeGitHub(repo)
  return {
    github,
    backend: createGitHubBackend({
      owner: 'octocat',
      repo: 'notes',
      ref: 'main',
      token: () => 'installation-token',
      fetch: github.fetch,
      // The timer is proved by its own test; everywhere else it would only add noise.
      autocommitMs: 0,
      now: opts.now,
    }),
  }
}

const VAULT: FakeRepo = {
  files: {
    'README.md': '# readme',
    'notes/a.md': 'alpha coroutine',
    'notes/deep/b.md': 'beta',
    'notes/图片.md': '中文正文',
    '.github/workflows/ci.yml': 'name: ci',
    'assets/logo.png': 'binary-ish',
  },
}

describe('tree', () => {
  it('rebuilds the nesting a flat git tree implies', async () => {
    const { backend } = backendFor(VAULT)
    const tree = await backend.tree()
    // `assets` is in here: whether it is *drawn* is a question for the browser, where the switch
    // is. A tree that dropped it could never show it again, whatever the switch said.
    expect(tree.map((e) => `${e.type}:${e.name}`)).toEqual([
      'dir:assets', 'dir:notes', 'file:README.md',
    ])
    const notes = tree.find((e) => e.name === 'notes')!
    expect(notes.children!.map((e) => `${e.type}:${e.name}`)).toEqual([
      'dir:deep', 'file:a.md', 'file:图片.md',
    ])
  })

  it('hides dot-directories, the way the server does', async () => {
    const { backend } = backendFor(VAULT)
    expect((await backend.tree()).some((e) => e.name === '.github')).toBe(false)
  })

  it('is read once and reused, so opening files does not re-list the repo', async () => {
    const { backend, github } = backendFor(VAULT)
    await backend.tree()
    await backend.readFile('notes/a.md')
    expect(github.calls.filter((c) => c.includes('/git/trees/'))).toHaveLength(1)
  })

  it('refuses a repository GitHub could only list in part', async () => {
    const { backend } = backendFor({ ...VAULT, truncated: true })
    await expect(backend.tree()).rejects.toMatchObject({ status: 422 })
  })
})

describe('readFile', () => {
  it('returns the blob sha as the rev, and no modified time', async () => {
    const { backend } = backendFor(VAULT)
    await expect(backend.readFile('notes/a.md')).resolves.toEqual({
      path: 'notes/a.md',
      content: 'alpha coroutine',
      rev: fakeSha('alpha coroutine'),
      modifiedAt: null,
    })
  })

  it('reads CJK text back unchanged — the raw media type skips base64', async () => {
    const { backend } = backendFor(VAULT)
    expect((await backend.readFile('notes/图片.md')).content).toBe('中文正文')
  })

  it('does not fetch a blob it already has', async () => {
    const { backend, github } = backendFor(VAULT)
    await backend.readFile('notes/a.md')
    await backend.readFile('notes/a.md')
    expect(github.calls.filter((c) => c.includes('/git/blobs/'))).toHaveLength(1)
  })

  it('reports a path that is not in the tree as missing', async () => {
    const { backend } = backendFor(VAULT)
    await expect(backend.readFile('nope.md')).rejects.toMatchObject({ status: 404 })
  })
})

describe('saving is not committing', () => {
  it('a save changes nothing on GitHub', async () => {
    const { backend, github } = backendFor(VAULT)
    await backend.writeFile('notes/a.md', 'edited')
    expect(github.writes).toEqual([])
    expect(github.files()['notes/a.md']).toBe('alpha coroutine')
  })

  it('reads back what was saved, with the time it was saved at', async () => {
    const { backend } = backendFor(VAULT, { now: () => 1_700_000_000_000 })
    await backend.writeFile('notes/a.md', 'edited')
    const file = await backend.readFile('notes/a.md')
    expect(file.content).toBe('edited')
    // Unlike committed text, this one has a date to show: the moment it was written here.
    expect(file.modifiedAt).toBe(1_700_000_000_000)
  })

  it('hands back a new rev each time, and refuses a write from an old one', async () => {
    const { backend } = backendFor(VAULT)
    const first = await backend.writeFile('notes/a.md', 'one')
    const second = await backend.writeFile('notes/a.md', 'two', first.rev)
    expect(second.rev).not.toBe(first.rev)
    await expect(backend.writeFile('notes/a.md', 'three', first.rev)).rejects.toMatchObject({
      status: 409,
      theirs: { content: 'two' },
    })
  })

  it('says the vault is dirty, and stays on zero to push', async () => {
    const { backend } = backendFor(VAULT)
    await expect(backend.gitStatus()).resolves.toMatchObject({ dirty: false, ahead: 0 })
    await backend.writeFile('notes/a.md', 'edited')
    await expect(backend.gitStatus()).resolves.toMatchObject({ dirty: true, ahead: 0 })
  })

  it('survives a reload, because the store is the working tree now', async () => {
    const first = backendFor(VAULT)
    await first.backend.writeFile('notes/a.md', 'written before the tab closed')
    // A second backend over the same repo is what a reload amounts to.
    const second = backendFor(VAULT)
    expect((await second.backend.readFile('notes/a.md')).content).toBe('written before the tab closed')
    await expect(second.backend.gitStatus()).resolves.toMatchObject({ dirty: true })
  })
})

describe('the tree while things are uncommitted', () => {
  it('shows a new file, and a new folder that git could not hold on its own', async () => {
    const { backend } = backendFor(VAULT)
    await backend.createEntry('notes/new.md', 'file')
    await backend.createEntry('empty', 'dir')
    const tree = await backend.tree()
    expect(tree.map((e) => e.name)).toContain('empty')
    const notes = tree.find((e) => e.name === 'notes')!
    expect(notes.children!.map((e) => e.name)).toContain('new.md')
  })

  it('hides a deleted file straight away', async () => {
    const { backend } = backendFor(VAULT)
    await backend.remove('README.md')
    expect((await backend.tree()).map((e) => e.name)).not.toContain('README.md')
    await expect(backend.readFile('README.md')).rejects.toMatchObject({ status: 404 })
  })

  it('refuses to create over something that is already there', async () => {
    const { backend } = backendFor(VAULT)
    await expect(backend.createEntry('README.md', 'file')).rejects.toMatchObject({ status: 409 })
  })

  it('renames a file, carrying its text', async () => {
    const { backend } = backendFor(VAULT)
    await backend.rename('notes/a.md', 'notes/renamed.md')
    expect((await backend.readFile('notes/renamed.md')).content).toBe('alpha coroutine')
    await expect(backend.readFile('notes/a.md')).rejects.toMatchObject({ status: 404 })
  })

  it('renames a folder by moving what is under it', async () => {
    const { backend } = backendFor(VAULT)
    await backend.rename('notes/deep', 'notes/shallow')
    expect((await backend.readFile('notes/shallow/b.md')).content).toBe('beta')
    await expect(backend.readFile('notes/deep/b.md')).rejects.toMatchObject({ status: 404 })
  })

  it('deleting a file that was never committed leaves nothing behind to commit', async () => {
    const { backend } = backendFor(VAULT)
    await backend.createEntry('scratch.md', 'file')
    await backend.remove('scratch.md')
    await expect(backend.gitStatus()).resolves.toMatchObject({ dirty: false })
    await expect(backend.gitChanges()).resolves.toEqual({ changes: [] })
  })
})

describe('the changes a commit would carry', () => {
  it('classifies each one, with its diff', async () => {
    const { backend } = backendFor(VAULT)
    await backend.writeFile('notes/a.md', 'alpha coroutine\nand a second line')
    await backend.createEntry('new.md', 'file')
    await backend.writeFile('new.md', 'brand new')
    await backend.remove('README.md')

    const { changes } = await backend.gitChanges()
    expect(changes.map((c) => `${c.status} ${c.path}`)).toEqual([
      'deleted README.md', 'added new.md', 'modified notes/a.md',
    ])
    expect(changes.find((c) => c.path === 'notes/a.md')!.diff).toContain('+and a second line')
    expect(changes.find((c) => c.path === 'README.md')!.removed).toBe(1)
  })

  it('does not count a file edited back to what was committed', async () => {
    const { backend } = backendFor(VAULT)
    await backend.writeFile('notes/a.md', 'something else')
    await backend.writeFile('notes/a.md', 'alpha coroutine')
    await expect(backend.gitChanges()).resolves.toEqual({ changes: [] })
  })

  it('leaves an empty folder out — git has nowhere to put one', async () => {
    const { backend } = backendFor(VAULT)
    await backend.createEntry('empty', 'dir')
    await expect(backend.gitChanges()).resolves.toEqual({ changes: [] })
  })
})

describe('commit', () => {
  it('carries every changed file in one commit', async () => {
    const { backend, github } = backendFor(VAULT)
    await backend.writeFile('notes/a.md', 'edited')
    await backend.writeFile('notes/deep/b.md', 'also edited')
    await backend.createEntry('third.md', 'file')
    await backend.writeFile('third.md', 'new one')
    await backend.remove('README.md')

    const result = await backend.commit('four at once')
    expect(result!.files).toEqual(['README.md', 'notes/a.md', 'notes/deep/b.md', 'third.md'])
    // The whole point: one commit object, not one per file.
    expect(github.writes.filter((w) => w.url.endsWith('/git/commits'))).toHaveLength(1)
    expect(github.writes.filter((w) => w.url.endsWith('/git/trees'))).toHaveLength(1)

    expect(github.files()).toEqual({
      'notes/a.md': 'edited',
      'notes/deep/b.md': 'also edited',
      'third.md': 'new one',
      'notes/图片.md': '中文正文',
      '.github/workflows/ci.yml': 'name: ci',
      'assets/logo.png': 'binary-ish',
    })
  })

  it('leaves nothing behind, and reports a clean vault afterwards', async () => {
    const { backend } = backendFor(VAULT)
    await backend.writeFile('notes/a.md', 'edited')
    await backend.commit('one')
    await expect(backend.gitStatus()).resolves.toMatchObject({ dirty: false })
    await expect(backend.gitChanges()).resolves.toEqual({ changes: [] })
    expect((await backend.readFile('notes/a.md')).content).toBe('edited')
  })

  it('is nothing to do when nothing changed', async () => {
    const { backend, github } = backendFor(VAULT)
    await expect(backend.commit('empty')).resolves.toBeNull()
    expect(github.writes).toEqual([])
  })

  it('writes the message it was given, and generates one when it was not', async () => {
    const { backend, github } = backendFor(VAULT)
    await backend.writeFile('notes/a.md', 'x')
    const mine = await backend.commit('a message I wrote')
    expect(github.message(mine!.sha)).toBe('a message I wrote')

    await backend.writeFile('notes/a.md', 'y')
    await backend.writeFile('notes/deep/b.md', 'y')
    const auto = await backend.commit('')
    expect(github.message(auto!.sha)).toBe('autosave: notes/a.md, notes/deep/b.md')
  })

  it('counts the files it did not name', async () => {
    const { backend, github } = backendFor({
      files: { 'a.md': '1', 'b.md': '2', 'c.md': '3', 'd.md': '4', 'e.md': '5' },
    })
    for (const p of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']) await backend.writeFile(p, 'edited')
    const auto = await backend.commit('')
    expect(github.message(auto!.sha)).toBe('autosave: a.md, b.md, c.md (+2 more)')
  })
})

describe('when the branch moved underneath', () => {
  it('refuses to overwrite it, and keeps every uncommitted edit', async () => {
    const { backend, github } = backendFor(VAULT)
    await backend.writeFile('notes/a.md', 'mine')
    github.moveBranch()

    await expect(backend.commit('mine')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('moved on GitHub'),
    })
    // Nothing lost, and the panel now has the other version to draw against.
    expect((await backend.readFile('notes/a.md')).content).toBe('mine')
    const { changes } = await backend.gitChanges()
    expect(changes.map((c) => c.path)).toEqual(['notes/a.md'])
    expect((await backend.tree()).map((e) => e.name)).toContain('someone-else.md')
  })

  it('takes the branch when the same commit is made again — deliberately, and only then', async () => {
    const { backend, github } = backendFor(VAULT)
    await backend.writeFile('notes/a.md', 'mine')
    github.moveBranch()
    await expect(backend.commit('mine')).rejects.toMatchObject({ status: 409 })

    const second = await backend.commit('mine, again')
    expect(second!.files).toEqual(['notes/a.md'])
    expect(github.files()['notes/a.md']).toBe('mine')
    // The other person's file is still there: this took the branch, it did not rewind it.
    expect(github.files()['someone-else.md']).toBe('written elsewhere')
  })
})

describe('search', () => {
  it('finds text that was saved but not committed', async () => {
    const { backend } = backendFor(VAULT)
    await backend.writeFile('notes/a.md', 'a word only in the working copy')
    const { notes } = await backend.corpus()
    expect(notes.find((n) => n.path === 'notes/a.md')!.text).toBe('a word only in the working copy')
  })

  it('stops offering a note that was deleted', async () => {
    const { backend } = backendFor(VAULT)
    await backend.remove('README.md')
    const { notes } = await backend.corpus()
    expect(notes.map((n) => n.path)).not.toContain('README.md')
  })

  it('collects the markdown and leaves everything else alone', async () => {
    const { backend } = backendFor(VAULT)
    const { notes, truncated } = await backend.corpus()
    expect(notes.map((n) => n.path)).toEqual([
      'README.md', 'notes/a.md', 'notes/deep/b.md', 'notes/图片.md',
    ])
    expect(truncated).toBe(false)
  })

  it('reuses blobs an open file already pulled', async () => {
    const { backend, github } = backendFor(VAULT)
    await backend.readFile('notes/a.md')
    const before = github.calls.filter((c) => c.includes('/git/blobs/')).length
    await backend.corpus()
    const after = github.calls.filter((c) => c.includes('/git/blobs/')).length
    expect(after - before).toBe(3)
  })

  it('skips a note past the per-file cap rather than failing the whole corpus', async () => {
    const { backend } = backendFor({ files: { 'big.md': 'x'.repeat(600 * 1024), 'small.md': 'ok' } })
    expect((await backend.corpus()).notes.map((n) => n.path)).toEqual(['small.md'])
  })
})

describe('the unattended commit', () => {
  it('runs on a timer, and only when there is something to commit', async () => {
    const github = fakeGitHub(VAULT)
    let tick: (() => void) | null = null
    const backend = createGitHubBackend({
      owner: 'octocat',
      repo: 'notes',
      ref: 'main',
      token: () => 'tok',
      fetch: github.fetch,
      setInterval: (fn) => { tick = fn; return 0 },
    })

    tick!()
    await Promise.resolve()
    expect(github.writes).toEqual([])

    await backend.writeFile('notes/a.md', 'typed and left alone')
    tick!()
    await vi.waitFor(() => { expect(github.files()['notes/a.md']).toBe('typed and left alone') })
  })

  /**
   * The commit nobody pressed still has to say so.
   *
   * A commit folds the working store's writes into a new base, so the rev the open document holds
   * stops existing and the next save is told the file changed underneath it — about the reader's
   * own text, committed by the reader's own editor. The manual path re-pointed the document
   * afterwards and the timer did not, which is why it only happened when you left the tab alone
   * for a while and then pressed Ctrl+S.
   */
  it('announces the commits nobody pressed, so the open document can re-point', async () => {
    const github = fakeGitHub(VAULT)
    let tick: (() => void) | null = null
    let committed = 0
    const backend = createGitHubBackend({
      owner: 'octocat',
      repo: 'notes',
      ref: 'main',
      token: () => 'tok',
      fetch: github.fetch,
      setInterval: (fn) => { tick = fn; return 0 },
      onCommitted: () => { committed += 1 },
    })

    const first = await backend.writeFile('notes/a.md', 'one')
    tick!()
    await vi.waitFor(() => { expect(committed).toBe(1) })

    // And the rev that write returned is now gone, which is the whole reason the announcement
    // matters: saving against it is what produced "This file was changed on disk".
    await expect(backend.writeFile('notes/a.md', 'two', first.rev)).rejects.toThrow()

    // Re-read, as the document does when it hears, and the next save goes through.
    const now = await backend.readFile('notes/a.md')
    await expect(backend.writeFile('notes/a.md', 'two', now.rev)).resolves.toBeDefined()
  })

  it('announces a commit that was pressed, by the same route', async () => {
    const github = fakeGitHub(VAULT)
    let committed = 0
    const backend = createGitHubBackend({
      owner: 'octocat',
      repo: 'notes',
      ref: 'main',
      token: () => 'tok',
      fetch: github.fetch,
      onCommitted: () => { committed += 1 },
    })

    await backend.writeFile('notes/a.md', 'one')
    await backend.commit('a message')
    expect(committed).toBe(1)
  })
})

describe('history', () => {
  const REPO: FakeRepo = {
    files: { 'a.md': 'body' },
    commits: {
      'a.md': [
        { sha: 'bbb', date: '2026-08-11T10:00:00Z', message: 'second\n\nwith a body' },
        { sha: 'aaa', date: '2026-08-10T10:00:00Z', message: 'first' },
      ],
    },
    diffs: {
      bbb: [
        'diff --git a/other.md b/other.md',
        'index 1..2 100644',
        '--- a/other.md',
        '+++ b/other.md',
        '@@ -1 +1 @@',
        '-not this one',
        'diff --git a/a.md b/a.md',
        'index 3..4 100644',
        '--- a/a.md',
        '+++ b/a.md',
        '@@ -1 +1,2 @@',
        ' body',
        '+added',
      ].join('\n'),
    },
  }

  it('lists the commits that touched a file, subject line only', async () => {
    const { backend } = backendFor(REPO)
    const { commits } = await backend.gitLog('a.md')
    expect(commits.map((c) => c.message)).toEqual(['second', 'first'])
    expect(commits[0]!.date).toBe('2026-08-11T10:00:00Z')
  })

  it('takes only the requested file out of a whole-commit diff, headers dropped', async () => {
    const { backend } = backendFor(REPO)
    await expect(backend.gitDiff('a.md', null, 'bbb')).resolves.toEqual({
      diff: '@@ -1 +1,2 @@\n body\n+added',
    })
  })

  it('reads a file as it was at a commit', async () => {
    const { backend } = backendFor(REPO)
    await expect(backend.fileAtCommit('a.md', 'aaa')).resolves.toEqual({ content: 'body' })
  })
})

describe('push', () => {
  it('has nothing to do, because committing already published', async () => {
    const { backend, github } = backendFor(VAULT)
    await expect(backend.push()).resolves.toEqual({ pushed: 0 })
    expect(github.writes).toEqual([])
  })

  it('has no event channel, and unsubscribing from it is safe', () => {
    const { backend } = backendFor(VAULT)
    const stop = backend.connect({ onEvent: () => { throw new Error('nothing should arrive') } })
    expect(() => { stop() }).not.toThrow()
  })
})

/**
 * Pictures.
 *
 * Two things are being held here and they are the whole design. The bytes go to GitHub the moment
 * they are pasted, as a blob no tree points at — so nothing large ever sits in `localStorage`, and
 * a paste that is never committed leaves nothing behind. And the cache is keyed by **sha**, never
 * by path: a path is only a name, and the same name can mean different bytes after a revert.
 */
describe('assets', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5])

  function backendFor2(repo: FakeRepo) {
    const github = fakeGitHub(repo)
    const backend = createGitHubBackend({
      owner: 'octocat', repo: 'notes', ref: 'main', token: () => 'tok',
      fetch: github.fetch, autocommitMs: 0,
    })
    return { github, backend }
  }

  it('sends the bytes at once, as a blob no commit references', async () => {
    const { github, backend } = backendFor2(VAULT)
    const { path } = await backend.writeAsset(bytes, 'webp')

    expect(path).toMatch(/^assets\/[a-f0-9]{16}\.webp$/)
    // One blob written, and the branch has not moved: nothing was committed.
    expect(github.writes.filter((w) => w.url.endsWith('/git/blobs'))).toHaveLength(1)
    expect(github.writes.filter((w) => w.url.endsWith('/git/commits'))).toHaveLength(0)
    expect(github.files()[path]).toBeUndefined()
  })

  it('writes the same picture once, however many times it is pasted', async () => {
    const { github, backend } = backendFor2(VAULT)
    const first = await backend.writeAsset(bytes, 'webp')
    const second = await backend.writeAsset(bytes, 'webp')
    expect(second).toEqual({ path: first.path, existed: true })
    expect(first.existed).toBe(false)
    expect(github.writes.filter((w) => w.url.endsWith('/git/blobs'))).toHaveLength(1)
  })

  it('a commit points the tree at the blob rather than uploading it again', async () => {
    const { github, backend } = backendFor2(VAULT)
    const { path } = await backend.writeAsset(bytes, 'webp')
    const blobsBefore = github.writes.filter((w) => w.url.endsWith('/git/blobs')).length

    const result = await backend.commit('with a picture')
    expect(result?.files).toContain(path)
    expect(github.files()[path]).toBeDefined()
    expect(github.writes.filter((w) => w.url.endsWith('/git/blobs'))).toHaveLength(blobsBefore)
  })

  it('puts a pasted one in the tree, uncommitted and all', async () => {
    const { backend } = backendFor2(VAULT)
    const { path } = await backend.writeAsset(bytes, 'webp')

    // The switch in Settings decides whether it is drawn; the tree's job is to know it is there.
    expect(JSON.stringify(await backend.tree())).toContain(path)

    const { changes } = await backend.gitChanges()
    expect(changes.map((c) => c.path)).toContain(path)
  })

  it('shows it as pending, with no diff to show for it', async () => {
    const { backend } = backendFor2(VAULT)
    const { path } = await backend.writeAsset(bytes, 'webp')
    const { changes } = await backend.gitChanges()
    const mine = changes.find((c) => c.path === path)
    expect(mine).toMatchObject({ status: 'added', added: 0, removed: 0, diff: '' })
  })

  it('hands back a URL, and asks for the bytes once', async () => {
    const { github, backend } = backendFor2(VAULT)
    const made: string[] = []
    const original = URL.createObjectURL
    URL.createObjectURL = ((blob: Blob) => { const u = `blob:fake/${made.length}`; made.push(u); return u }) as typeof URL.createObjectURL
    try {
      const { path } = await backend.writeAsset(bytes, 'webp')
      const a = await backend.assetUrl(path)
      const b = await backend.assetUrl(`/${path}`)
      expect(a).toBe(b)
      // One object URL for one sha — a second would be a second blob the browser keeps alive.
      expect(made).toHaveLength(1)
      expect(github.calls.filter((u) => /\/git\/blobs\/[^/]+$/.test(u))).toHaveLength(0)
    } finally {
      URL.createObjectURL = original
    }
  })

  it('says nothing for a path that is not a picture', async () => {
    const { backend } = backendFor2(VAULT)
    expect(await backend.assetUrl('notes/a.md')).toBeNull()
    expect(await backend.assetUrl('assets/deadbeefdeadbeef.webp')).toBeNull()
  })
})
