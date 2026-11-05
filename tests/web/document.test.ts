import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendError, ConflictError, type FileSnapshot } from '../../src/web/api/backend.js'
import * as apiModule from '../../src/web/api/index.js'
import {
  baseRev,
  conflict,
  content,
  loadingPath,
  DRAFT_KEY_PREFIX,
  dirty,
  editContent,
  flushSave,
  forgetOurWrites,
  handleExternalChange,
  openFile,
  resolveConflictKeepMine,
  resolveConflictTakeDisk,
  fileError,
  saveError,
  saveState,
  savingPath,
  drafts,
  saveAll,
  saveAllError,
} from '../../src/web/state/document.js'
import { currentPath } from '../../src/web/state/vault.js'

const readFile = vi.spyOn(apiModule.backend, 'readFile')
const writeFile = vi.spyOn(apiModule.backend, 'writeFile')

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  drafts.value = new Map()
  readFile.mockReset()
  writeFile.mockReset()
  currentPath.value = null
  content.value = ''
  baseRev.value = null
  conflict.value = null
  fileError.value = null
  dirty.value = false
  loadingPath.value = null
  savingPath.value = null
  forgetOurWrites()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('committing moves the base the document is measured against', () => {
  it('re-points baseRev so the next save is not called a conflict', async () => {
    const { rebaseOpenDocument } = await import('../../src/web/state/document.js')
    currentPath.value = 'a.md'
    baseRev.value = 'local:5'
    content.value = 'text'

    // What a commit does: the local rev stops existing and the file is at a new base.
    readFile.mockResolvedValue({ path: 'a.md', content: 'text', rev: 'sha-after-commit', modifiedAt: 9 })
    await rebaseOpenDocument()

    expect(baseRev.value).toBe('sha-after-commit')

    // And the next save goes out against the new base rather than the vanished one.
    writeFile.mockResolvedValueOnce({ rev: 'local:6', modifiedAt: 10 })
    content.value = 'text and more'
    dirty.value = true
    await flushSave()
    expect(writeFile).toHaveBeenCalledWith('a.md', 'text and more', 'sha-after-commit')
  })

  it('leaves the text alone, including anything typed since', async () => {
    const { rebaseOpenDocument } = await import('../../src/web/state/document.js')
    currentPath.value = 'a.md'
    baseRev.value = 'local:5'
    content.value = 'typed after the commit began'
    dirty.value = true
    readFile.mockResolvedValue({ path: 'a.md', content: 'what was committed', rev: 'sha', modifiedAt: 9 })

    await rebaseOpenDocument()

    // Only the rev moves. Taking the committed text would discard unsaved work.
    expect(content.value).toBe('typed after the commit began')
    expect(dirty.value).toBe(true)
  })
})

describe('a write of ours, echoed back late', () => {
  it('is not a conflict, even after baseRev has moved past it', async () => {
    // Real revs are epoch milliseconds, and `isSameRev` treats anything within a small grace
    // window as the same write — so these have to be seconds apart to be different at all.
    currentPath.value = 'a.md'
    baseRev.value = '1000000'
    content.value = 'one'
    dirty.value = true

    writeFile.mockResolvedValueOnce({ rev: '1010000', modifiedAt: 1010000 })
    await flushSave()
    content.value = 'two'
    dirty.value = true
    writeFile.mockResolvedValueOnce({ rev: '1020000', modifiedAt: 1020000 })
    await flushSave()

    // The echo of the *first* save turns up now. chokidar debounces and a save behind another is
    // serialized, so this is ordinary rather than exotic — and `baseRev` is already at 3.
    content.value = 'three'
    dirty.value = true
    await handleExternalChange('a.md', '1010000')

    // It is our own write. Before this it read as somebody else's and interrupted the typing with
    // "This file was changed on disk."
    expect(conflict.value).toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('still reports a write that was genuinely somebody else\'s', async () => {
    currentPath.value = 'a.md'
    baseRev.value = '1000000'
    content.value = 'mine'
    dirty.value = true
    readFile.mockResolvedValue({ path: 'a.md', content: 'theirs', rev: '9000000', modifiedAt: 9000000 })

    await handleExternalChange('a.md', '9000000')

    expect(conflict.value).toMatchObject({ content: 'theirs', rev: '9000000' })
  })

  it('forgets writes older than the last few, so a stale rev is not trusted forever', async () => {
    currentPath.value = 'a.md'
    baseRev.value = '1000000'
    for (const rev of ['2000000', '3000000', '4000000', '5000000', '6000000']) {
      content.value = `v${rev}`
      dirty.value = true
      writeFile.mockResolvedValueOnce({ rev, modifiedAt: Number(rev) })
      await flushSave()
    }
    content.value = 'now'
    dirty.value = true
    readFile.mockResolvedValue({ path: 'a.md', content: 'theirs', rev: '2000000', modifiedAt: 2000000 })

    await handleExternalChange('a.md', '2000000')

    // Five writes ago is not an echo any more; trusting it forever would let a real outside change
    // that happened to reuse the rev slip through unnoticed.
    expect(conflict.value).not.toBeNull()
  })
})

describe('openFile', () => {
  it('claims the path before the read, not after', async () => {
    // The whole bug: between a tap and the text, the app used to believe no file was open, so the
    // editor column said so — for 221ms over a 200ms round trip.
    let resolveRead: (v: FileSnapshot) => void = () => {}
    readFile.mockImplementation(() => new Promise((r) => { resolveRead = r }))

    const opening = openFile('a.md')
    expect(currentPath.value).toBe('a.md')
    expect(loadingPath.value).toBe('a.md')

    resolveRead({ path: 'a.md', content: '# a', rev: '1', modifiedAt: 1 })
    await opening
    expect(loadingPath.value).toBeNull()
    expect(content.value).toBe('# a')
  })

  it('puts the path back when the read fails', async () => {
    readFile.mockResolvedValue({ path: 'first.md', content: 'x', rev: '1', modifiedAt: 1 })
    await openFile('first.md')

    readFile.mockRejectedValue(new Error('not found'))
    await openFile('gone.md')
    expect(currentPath.value).toBe('first.md')
    expect(loadingPath.value).toBeNull()
    expect(saveError.value).toContain('not found')
  })

  it('lets the last note asked for win a race', async () => {
    let resolveSlow: (v: FileSnapshot) => void = () => {}
    readFile.mockImplementationOnce(() => new Promise((r) => { resolveSlow = r }))
    const slow = openFile('slow.md')

    readFile.mockResolvedValue({ path: 'fast.md', content: 'fast', rev: '2', modifiedAt: 2 })
    await openFile('fast.md')

    // The first read lands late and must not overwrite the note now on screen.
    resolveSlow({ path: 'slow.md', content: 'slow', rev: '1', modifiedAt: 1 })
    await slow
    expect(currentPath.value).toBe('fast.md')
    expect(content.value).toBe('fast')
  })

  it('loads content and mtime', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: '# a', rev: '100', modifiedAt: 100 })
    await openFile('a.md')
    expect(content.value).toBe('# a')
    expect(baseRev.value).toBe('100')
    expect(currentPath.value).toBe('a.md')
    expect(dirty.value).toBe(false)
  })

  it('when a draft exists, prefers the draft and marks it dirty', async () => {
    localStorage.setItem(`${DRAFT_KEY_PREFIX}a.md`, 'unsaved draft')
    readFile.mockResolvedValue({ path: 'a.md', content: '# a', rev: '100', modifiedAt: 100 })
    await openFile('a.md')
    expect(content.value).toBe('unsaved draft')
    expect(dirty.value).toBe(true)
  })
})

describe('manual save', () => {
  it('Save all saves drafts of notes that have been switched away from', async () => {
    readFile.mockResolvedValueOnce({ path: 'a.md', content: 'a', rev: 'a1', modifiedAt: 1 })
    await openFile('a.md')
    editContent('draft a')
    readFile.mockResolvedValueOnce({ path: 'b.md', content: 'b', rev: 'b1', modifiedAt: 2 })
    await openFile('b.md')
    editContent('draft b')
    readFile.mockImplementation(async (path) => ({ path, content: path === 'a.md' ? 'a' : 'b', rev: path === 'a.md' ? 'a1' : 'b1', modifiedAt: 1 }))
    writeFile.mockImplementation(async (path) => ({ rev: `${path}-saved`, modifiedAt: 3 }))
    vi.spyOn(apiModule.backend, 'gitStatus').mockResolvedValue({ dirty: true, branch: 'main', hasRemote: false, ahead: 0 })
    await saveAll()
    expect(writeFile).toHaveBeenCalledWith('a.md', 'draft a', 'a1')
    expect(writeFile).toHaveBeenCalledWith('b.md', 'draft b', 'b1')
    expect(currentPath.value).toBe('b.md')
    expect(content.value).toBe('draft b')
    expect(dirty.value).toBe(false)
    expect(drafts.value.size).toBe(0)
  })

  it('Save all preserves a conflicting draft and continues saving the other notes', async () => {
    readFile.mockResolvedValueOnce({ path: 'a.md', content: 'a', rev: 'a1', modifiedAt: 1 })
    await openFile('a.md')
    editContent('draft a')
    readFile.mockResolvedValueOnce({ path: 'b.md', content: 'b', rev: 'b1', modifiedAt: 2 })
    await openFile('b.md')
    editContent('draft b')
    readFile.mockImplementation(async (path) => ({ path, content: path === 'a.md' ? 'a' : 'b', rev: path === 'a.md' ? 'a1' : 'b1', modifiedAt: 1 }))
    writeFile.mockImplementation(async (path) => {
      if (path === 'a.md') throw new ConflictError('changed externally', { path, content: 'theirs', rev: 'a2', modifiedAt: 2 })
      return { rev: 'b2', modifiedAt: 3 }
    })
    vi.spyOn(apiModule.backend, 'gitStatus').mockResolvedValue({ dirty: true, branch: 'main', hasRemote: false, ahead: 0 })
    await saveAll()
    expect(saveAllError.value).toContain('a.md')
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBe('draft a')
    expect([...drafts.value.values()].map((draft) => draft.path)).toEqual(['a.md'])
    expect(dirty.value).toBe(false)
  })

  it('a queued save for one note cannot start saving a different note', async () => {
    readFile.mockResolvedValueOnce({ path: 'a.md', content: 'a', rev: 'a1', modifiedAt: 1 })
    await openFile('a.md')
    editContent('saved a')
    let finish!: (result: { rev: string; modifiedAt: number }) => void
    writeFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = flushSave()
    const queued = flushSave()
    readFile.mockResolvedValueOnce({ path: 'b.md', content: 'b', rev: 'b1', modifiedAt: 2 })
    await openFile('b.md')
    editContent('unsaved b')
    finish({ rev: 'a2', modifiedAt: 3 })
    await Promise.all([pending, queued])
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(dirty.value).toBe(true)
    expect(content.value).toBe('unsaved b')
  })

  it('reopening the same note during a save still adopts its new base', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'a', rev: 'a1', modifiedAt: 1 })
    await openFile('a.md')
    editContent('saved a')
    let finish!: (result: { rev: string; modifiedAt: number }) => void
    writeFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = flushSave()
    await openFile('a.md')
    finish({ rev: 'a2', modifiedAt: 2 })
    await pending
    expect(baseRev.value).toBe('a2')
    expect(dirty.value).toBe(false)
    expect(content.value).toBe('saved a')
  })

  it('a delayed save never clears another note’s draft or replaces its base revision', async () => {
    readFile.mockResolvedValueOnce({ path: 'a.md', content: 'a', rev: 'a1', modifiedAt: 1 })
    await openFile('a.md')
    editContent('saved a')
    let finish!: (result: { rev: string; modifiedAt: number }) => void
    writeFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = flushSave()
    expect(saveState.value).toBe('saving')
    readFile.mockResolvedValueOnce({ path: 'b.md', content: 'b', rev: 'b1', modifiedAt: 2 })
    await openFile('b.md')
    editContent('unsaved b')
    expect(saveState.value).toBe('unsaved')
    finish({ rev: 'a2', modifiedAt: 3 })
    await pending
    expect(content.value).toBe('unsaved b')
    expect(baseRev.value).toBe('b1')
    expect(dirty.value).toBe(true)
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}b.md`)).toBe('unsaved b')
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBeNull()
  })

  it('a delayed save failure is not reported against the newly opened note', async () => {
    readFile.mockResolvedValueOnce({ path: 'a.md', content: 'a', rev: 'a1', modifiedAt: 1 })
    await openFile('a.md')
    editContent('draft a')
    let fail!: (error: Error) => void
    writeFile.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const pending = flushSave()
    readFile.mockResolvedValueOnce({ path: 'b.md', content: 'b', rev: 'b1', modifiedAt: 2 })
    await openFile('b.md')
    fail(new Error('write failed'))
    await pending
    expect(saveState.value).toBe('saved')
    expect(fileError.value).toBeNull()
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBe('draft a')
  })

  it('save cannot write the previous text into a note that is still loading', async () => {
    currentPath.value = 'b.md'
    loadingPath.value = 'b.md'
    dirty.value = true
    content.value = 'previous note text'
    await flushSave()
    expect(writeFile).not.toHaveBeenCalled()
    expect(saveState.value).toBe('loading')
  })

  it('editContent sets dirty but does not auto-persist', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 })
    writeFile.mockResolvedValue({ rev: '2', modifiedAt: 2 })
    await openFile('a.md')
    editContent('typed')
    expect(dirty.value).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)     // no matter how long we wait, it must not persist
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('flushSave persists and clears dirty + clears the draft', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 })
    writeFile.mockResolvedValue({ rev: '9', modifiedAt: 9 })
    await openFile('a.md')
    editContent('typed')
    await flushSave()
    expect(writeFile).toHaveBeenCalledWith('a.md', 'typed', '1')
    expect(dirty.value).toBe(false)
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBeNull()
  })

  it('editContent writes the draft synchronously (crash-fallback retention)', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 })
    await openFile('a.md')
    editContent('draft-me')
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBe('draft-me')
  })

  it('a failed save retains dirty + draft + saveError', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 })
    writeFile.mockRejectedValue(new BackendError('disk full', 500))
    await openFile('a.md')
    editContent('changed')
    await flushSave()
    expect(dirty.value).toBe(true)
    expect(saveError.value).toContain('disk full')
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBe('changed')
  })

  it('after a successful save, updates the base rev and removes the draft', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 })
    writeFile.mockResolvedValue({ rev: '42', modifiedAt: 42 })
    await openFile('a.md')
    editContent('changed')
    await flushSave()
    expect(baseRev.value).toBe('42')
    expect(dirty.value).toBe(false)
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBeNull()
  })

  it('typing while a save is in progress: still dirty after persisting (newer content awaits saving)', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 })
    let resolveWrite: (v: { rev: string; modifiedAt: number }) => void = () => {}
    writeFile.mockImplementation(() => new Promise((r) => { resolveWrite = r }))
    await openFile('a.md')

    editContent('first')
    const savePromise = flushSave() // triggered manually; writeFile starts waiting asynchronously
    editContent('first-plus') // keep typing while the save is in progress
    resolveWrite({ rev: '2', modifiedAt: 2 }) // the write of the old snapshot completes
    await savePromise
    expect(dirty.value).toBe(true) // must not falsely report saved; first-plus is still unsaved
  })
})

describe('conflict', () => {
  it('on 409, sets conflict and does not modify local content', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 })
    writeFile.mockRejectedValue(
      new ConflictError('changed on disk', { path: 'a.md', content: 'theirs', rev: '9', modifiedAt: 9 }),
    )
    await openFile('a.md')
    editContent('mine')
    await flushSave()

    expect(conflict.value).toEqual({ path: 'a.md', content: 'theirs', rev: '9', modifiedAt: 9 })
    expect(content.value).toBe('mine')
  })

  it('takeDisk overwrites local with the disk content', async () => {
    conflict.value = { path: 'a.md', content: 'theirs', rev: '9', modifiedAt: 9 }
    content.value = 'mine'
    resolveConflictTakeDisk()
    expect(content.value).toBe('theirs')
    expect(baseRev.value).toBe('9')
    expect(conflict.value).toBeNull()
    expect(dirty.value).toBe(false)
  })

  it('keepMine re-saves using their rev as the baseline', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 })
    await openFile('a.md')
    content.value = 'mine'
    dirty.value = true
    conflict.value = { path: 'a.md', content: 'theirs', rev: '9', modifiedAt: 9 }
    writeFile.mockResolvedValue({ rev: '10', modifiedAt: 10 })

    await resolveConflictKeepMine()
    expect(writeFile).toHaveBeenCalledWith('a.md', 'mine', '9')
    expect(conflict.value).toBeNull()
    expect(dirty.value).toBe(false)
  })
})

describe('handleExternalChange', () => {
  it('does nothing when a non-current file is changed', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 })
    await openFile('a.md')
    readFile.mockClear()
    await handleExternalChange('other.md', '5')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('auto-reloads when the current file changes and local is clean', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 })
    await openFile('a.md')
    readFile.mockResolvedValue({ path: 'a.md', content: 'from codex', rev: '5', modifiedAt: 5 })
    await handleExternalChange('a.md', '5')
    expect(content.value).toBe('from codex')
    expect(baseRev.value).toBe('5')
    expect(conflict.value).toBeNull()
    expect(dirty.value).toBe(false)
  })

  it('shows the conflict bar without overwriting when the current file changes and local is dirty', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 })
    await openFile('a.md')
    editContent('mine')
    readFile.mockResolvedValue({ path: 'a.md', content: 'from codex', rev: '5', modifiedAt: 5 })

    await handleExternalChange('a.md', '5')
    expect(content.value).toBe('mine')
    expect(conflict.value).toEqual({ path: 'a.md', content: 'from codex', rev: '5', modifiedAt: 5 })
  })

  it('ignores a rev equal to the local baseline (an echo of our own write)', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', rev: '7', modifiedAt: 7 })
    await openFile('a.md')
    readFile.mockClear()
    await handleExternalChange('a.md', '7')
    expect(readFile).not.toHaveBeenCalled()
  })
})

describe('late reads belong to the document that requested them', () => {
  const file = (path: string, text = path): FileSnapshot => ({ path, content: text, rev: `rev:${text}`, modifiedAt: 1 })

  it('ignores an older failure while another note is loading', async () => {
    let fail!: (error: Error) => void
    let finish!: (snapshot: FileSnapshot) => void
    readFile.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const old = openFile('a.md')
    const next = openFile('b.md')
    fail(new Error('old request failed'))
    await old
    expect(loadingPath.value).toBe('b.md')
    expect(fileError.value).toBeNull()
    finish(file('b.md'))
    await next
    expect(content.value).toBe('b.md')
  })

  it('keeps the newest read when the same path is opened twice', async () => {
    let finish!: (snapshot: FileSnapshot) => void
    readFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValueOnce(file('a.md', 'new'))
    const old = openFile('a.md')
    await openFile('a.md')
    finish(file('a.md', 'old'))
    await old
    expect(content.value).toBe('new')
    expect(baseRev.value).toBe('rev:new')
  })

  for (const kind of ['external change', 'commit rebase']) {
    it(`does not apply a late ${kind} to the next note`, async () => {
      const { rebaseOpenDocument } = await import('../../src/web/state/document.js')
      readFile.mockResolvedValueOnce(file('a.md'))
      await openFile('a.md')
      let finish!: (snapshot: FileSnapshot) => void
      readFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
        .mockResolvedValueOnce(file('b.md'))
      const old = kind === 'external change' ? handleExternalChange('a.md', 'external') : rebaseOpenDocument()
      await openFile('b.md')
      editContent('new note draft')
      finish(file('a.md', 'old note update'))
      await old
      expect(content.value).toBe('new note draft')
      expect(baseRev.value).toBe('rev:b.md')
      expect(conflict.value).toBeNull()
      expect([...drafts.value.values()].find((draft) => draft.path === 'b.md')?.base).toBe('rev:b.md')
    })
  }

  it('flushes pending editor keystrokes before adopting an external change', async () => {
    const { provideEditorFlush } = await import('../../src/web/editor/current.js')
    readFile.mockResolvedValueOnce(file('a.md'))
    await openFile('a.md')
    readFile.mockResolvedValueOnce(file('a.md', 'external'))
    provideEditorFlush(() => editContent('last keystrokes'))
    try {
      await handleExternalChange('a.md', 'external')
      expect(content.value).toBe('last keystrokes')
      expect(conflict.value?.content).toBe('external')
    } finally { provideEditorFlush(null) }
  })
})

describe('moving notes carries unsaved buffers and their revision', () => {
  it('moves open and closed drafts under a renamed folder, rebasing only unchanged files', async () => {
    const { renameDocuments } = await import('../../src/web/state/document.js')
    const files = new Map<string, FileSnapshot>(['a', 'b'].map((name) => [`old/${name}.md`, {
      path: `old/${name}.md`, content: name, rev: `old:${name}`, modifiedAt: 1,
    }]))
    readFile.mockImplementation(async (path) => {
      const file = files.get(path)
      if (!file) throw new Error('missing file')
      return file
    })
    const rename = vi.spyOn(apiModule.backend, 'rename').mockImplementation(async () => {
      for (const [path, file] of [...files]) {
        files.delete(path)
        const next = path.replace('old/', 'new/')
        files.set(next, { ...file, path: next, rev: `new:${file.content}` })
      }
    })
    try {
      await openFile('old/a.md')
      editContent('draft a')
      await openFile('old/b.md')
      editContent('draft b')
      await renameDocuments('old', 'new')
      expect(currentPath.value).toBe('new/b.md')
      expect(content.value).toBe('draft b')
      expect(baseRev.value).toBe('new:b')
      expect([...drafts.value.values()].map(({ path, content, base }) => ({ path, content, base }))).toEqual([
        { path: 'new/a.md', content: 'draft a', base: 'new:a' },
        { path: 'new/b.md', content: 'draft b', base: 'new:b' },
      ])
      expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}old/a.md`)).toBeNull()
      expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}new/a.md`)).toBe('draft a')
      writeFile.mockResolvedValueOnce({ rev: 'saved', modifiedAt: 2 })
      await flushSave()
      expect(writeFile).toHaveBeenCalledWith('new/b.md', 'draft b', 'new:b')
    } finally { rename.mockRestore() }
  })

  it('keeps a stale draft base when a move also encounters changed disk content', async () => {
    const { renameDocuments } = await import('../../src/web/state/document.js')
    const rename = vi.spyOn(apiModule.backend, 'rename').mockResolvedValue()
    try {
      readFile.mockResolvedValueOnce({ path: 'a.md', content: 'original', rev: 'old', modifiedAt: 1 })
      await openFile('a.md')
      editContent('mine')
      readFile.mockResolvedValueOnce({ path: 'a.md', content: 'external', rev: 'other', modifiedAt: 2 })
        .mockResolvedValueOnce({ path: 'b.md', content: 'external', rev: 'moved', modifiedAt: 3 })
      await renameDocuments('a.md', 'b.md')
      expect(content.value).toBe('mine')
      expect(baseRev.value).toBe('old')
      expect([...drafts.value.values()][0]).toMatchObject({ path: 'b.md', content: 'mine', base: 'old' })
    } finally { rename.mockRestore() }
  })
})

it('a failed open never restores a still-loading path with another note’s buffer', async () => {
  readFile.mockResolvedValueOnce({ path: 'a.md', content: 'A only', rev: 'a', modifiedAt: 1 })
  await openFile('a.md')
  let finish!: (snapshot: FileSnapshot) => void
  readFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    .mockRejectedValueOnce(new Error('C failed'))
  const b = openFile('b.md')
  await openFile('c.md')
  expect(currentPath.value).toBeNull()
  expect(content.value).toBe('')
  expect(baseRev.value).toBeNull()
  finish({ path: 'b.md', content: 'B only', rev: 'b', modifiedAt: 2 })
  await b
  expect(currentPath.value).toBeNull()
  expect(content.value).toBe('')
})

it('a rejected rename retains both draft paths and leaves subsequent saves usable', async () => {
  const { renameDocuments } = await import('../../src/web/state/document.js')
  readFile.mockResolvedValue({ path: 'a.md', content: 'disk', rev: 'old', modifiedAt: 1 })
  await openFile('a.md')
  editContent('mine')
  localStorage.setItem(`${DRAFT_KEY_PREFIX}b.md`, 'other draft')
  const rename = vi.spyOn(apiModule.backend, 'rename')
  try {
    await expect(renameDocuments('a.md', 'b.md')).rejects.toThrow('unsaved draft')
    expect(rename).not.toHaveBeenCalled()
    expect(currentPath.value).toBe('a.md')
    expect(content.value).toBe('mine')
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}b.md`)).toBe('other draft')
    writeFile.mockResolvedValueOnce({ rev: 'saved', modifiedAt: 2 })
    await flushSave()
    expect(writeFile).toHaveBeenCalledWith('a.md', 'mine', 'old')
  } finally { rename.mockRestore() }
})
