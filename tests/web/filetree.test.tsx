import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTree } from '../../src/web/filetree/FileTree.js'
import { currentPath, expandedDirs, pendingOp, startCreate, tree, treeError } from '../../src/web/state/vault.js'
import { baseRev, content, dirty, DRAFT_KEY_PREFIX, fileError } from '../../src/web/state/document.js'
import * as apiModule from '../../src/web/api/index.js'
import type { VaultEntry } from '../../src/shared/types.js'
import { setShowAssets } from '../../src/web/state/settings.js'
import { invalidateCorpus } from '../../src/web/state/search.js'

/** Opens a row's ⋯ menu and clicks one of its items. */
function rowAction(name: string, item: string) {
  fireEvent.click(screen.getByLabelText(`Actions for ${name}`))
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
}


const SAMPLE: VaultEntry[] = [
  {
    name: 'notes',
    path: 'notes',
    type: 'dir',
    children: [
      { name: 'a.md', path: 'notes/a.md', type: 'file' },
      { name: 'b.md', path: 'notes/b.md', type: 'file' },
    ],
  },
  { name: 'readme.md', path: 'readme.md', type: 'file' },
]

beforeEach(() => {
  tree.value = SAMPLE
  currentPath.value = null
  expandedDirs.value = new Set()
  content.value = ''
  dirty.value = false
  baseRev.value = null
  fileError.value = null
  pendingOp.value = null
  treeError.value = null
  localStorage.clear()
  invalidateCorpus()
})

describe('FileTree rendering', () => {
  it('renders top-level entries', () => {
    render(<FileTree onOpenFile={() => {}} />)
    expect(screen.getByText('notes')).toBeTruthy()
    expect(screen.getByText('readme.md')).toBeTruthy()
  })

  it('directories are collapsed by default and children are hidden', () => {
    render(<FileTree onOpenFile={() => {}} />)
    expect(screen.queryByText('a.md')).toBeNull()
  })

  it('clicking a directory expands its children', () => {
    render(<FileTree onOpenFile={() => {}} />)
    fireEvent.click(screen.getByText('notes'))
    expect(screen.getByText('a.md')).toBeTruthy()
  })

  it('clicking again collapses it', () => {
    render(<FileTree onOpenFile={() => {}} />)
    fireEvent.click(screen.getByText('notes'))
    fireEvent.click(screen.getByText('notes'))
    expect(screen.queryByText('a.md')).toBeNull()
  })
})

describe('FileTree interaction', () => {
  it('clicking a file triggers onOpenFile', () => {
    const onOpenFile = vi.fn()
    render(<FileTree onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getByText('readme.md'))
    expect(onOpenFile).toHaveBeenCalledWith('readme.md')
  })

  it('clicking a directory does not trigger onOpenFile', () => {
    const onOpenFile = vi.fn()
    render(<FileTree onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getByText('notes'))
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('the current file has the selected class', () => {
    currentPath.value = 'readme.md'
    render(<FileTree onOpenFile={() => {}} />)
    expect(screen.getByText('readme.md').closest('.ink-tree-row')?.className).toContain('selected')
  })

  it('nested levels are indented', () => {
    expandedDirs.value = new Set(['notes'])
    render(<FileTree onOpenFile={() => {}} />)
    const row = screen.getByText('a.md').closest('.ink-tree-row') as HTMLElement
    expect(row.style.paddingLeft).not.toBe('')
  })
})

describe('FileTree empty state', () => {
  it('an empty vault shows a hint', () => {
    tree.value = []
    render(<FileTree onOpenFile={() => {}} />)
    expect(screen.getByText(/No notes yet/)).toBeTruthy()
  })
})

describe('file tree operations', () => {
  it('new file: the header button triggers pendingOp; submitting calls createEntry and opens it', async () => {
    const create = vi.spyOn(apiModule.backend, 'createEntry').mockResolvedValue()
    vi.spyOn(apiModule.backend, 'tree').mockResolvedValue([])
    render(<FileTree onOpenFile={() => {}} />)
    act(() => { startCreate('create-file') })
    const input = screen.getByRole('textbox')
    fireEvent.input(input, { target: { value: 'new.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(create).toHaveBeenCalledWith('new.md', 'file'))
  })
  it('delete: calls remove after inline confirmation', async () => {
    tree.value = [{ name: 'a.md', path: 'a.md', type: 'file' }]
    const remove = vi.spyOn(apiModule.backend, 'remove').mockResolvedValue()
    vi.spyOn(apiModule.backend, 'tree').mockResolvedValue([])
    render(<FileTree onOpenFile={() => {}} />)
    // hover to reveal the delete icon → click → inline confirm ✓
    rowAction('a.md', 'Delete')
    fireEvent.click(screen.getByTitle('Confirm delete'))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('a.md'))
  })

  it('deleting the currently open file: clears content/dirty/baseRev and removes the localStorage draft', async () => {
    tree.value = [{ name: 'a.md', path: 'a.md', type: 'file' }]
    // Simulate a file open with unsaved draft
    currentPath.value = 'a.md'
    content.value = 'unsaved text'
    dirty.value = true
    baseRev.value = '42'
    localStorage.setItem(`${DRAFT_KEY_PREFIX}a.md`, 'unsaved text')

    vi.spyOn(apiModule.backend, 'remove').mockResolvedValue()
    vi.spyOn(apiModule.backend, 'tree').mockResolvedValue([])
    render(<FileTree onOpenFile={() => {}} />)
    rowAction('a.md', 'Delete')
    fireEvent.click(screen.getByTitle('Confirm delete'))

    await waitFor(() => expect(currentPath.value).toBeNull())
    expect(content.value).toBe('')
    expect(dirty.value).toBe(false)
    expect(baseRev.value).toBeNull()
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBeNull()
  })

  it('deleting a non-current file: does not affect the open document state', async () => {
    tree.value = [
      { name: 'a.md', path: 'a.md', type: 'file' },
      { name: 'b.md', path: 'b.md', type: 'file' },
    ]
    // a.md is open with content
    currentPath.value = 'a.md'
    content.value = 'open content'
    dirty.value = true
    baseRev.value = '7'
    localStorage.setItem(`${DRAFT_KEY_PREFIX}a.md`, 'open content')

    vi.spyOn(apiModule.backend, 'remove').mockResolvedValue()
    vi.spyOn(apiModule.backend, 'tree').mockResolvedValue([{ name: 'a.md', path: 'a.md', type: 'file' }])
    render(<FileTree onOpenFile={() => {}} />)
    // Delete b.md (not the open file)
    rowAction('b.md', 'Delete')
    fireEvent.click(screen.getByTitle('Confirm delete'))

    await waitFor(() => expect(apiModule.backend.remove).toHaveBeenCalledWith('b.md'))
    // Open document state must be untouched
    expect(currentPath.value).toBe('a.md')
    expect(content.value).toBe('open content')
    expect(dirty.value).toBe(true)
    expect(baseRev.value).toBe('7')
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBe('open content')
  })
  it('the current dirty file row shows the unsaved dot', () => {
    tree.value = [{ name: 'a.md', path: 'a.md', type: 'file' }]
    currentPath.value = 'a.md'; dirty.value = true
    const { container } = render(<FileTree onOpenFile={() => {}} />)
    expect(container.querySelector('.ink-unsaved-dot')).toBeTruthy()
  })
  it('new file in a subdirectory: the input appears under the directory and the createEntry path includes the subdirectory', async () => {
    // notes dir is in SAMPLE; expand it so it's visible
    expandedDirs.value = new Set(['notes'])
    currentPath.value = 'notes'
    const create = vi.spyOn(apiModule.backend, 'createEntry').mockResolvedValue()
    vi.spyOn(apiModule.backend, 'tree').mockResolvedValue([])
    render(<FileTree onOpenFile={() => {}} />)
    act(() => { startCreate('create-file') })
    // An input should now be visible (inside the notes dir, not root)
    const input = screen.getByRole('textbox')
    expect(input).toBeTruthy()
    fireEvent.input(input, { target: { value: 'x.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(create).toHaveBeenCalledWith('notes/x.md', 'file'))
  })

  it('a failed rename sets treeError', async () => {
    tree.value = [{ name: 'a.md', path: 'a.md', type: 'file' }]
    vi.spyOn(apiModule.backend, 'rename').mockRejectedValue(new Error('boom'))
    vi.spyOn(apiModule.backend, 'tree').mockResolvedValue([])
    render(<FileTree onOpenFile={() => {}} />)
    rowAction('a.md', 'Rename')
    const input = screen.getByRole('textbox')
    fireEvent.input(input, { target: { value: 'b.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(treeError.value).not.toBeNull())
  })

  it('when a rename starts, the input text is fully selected', async () => {
    tree.value = [{ name: 'a.md', path: 'a.md', type: 'file' }]
    render(<FileTree onOpenFile={() => {}} />)
    rowAction('a.md', 'Rename')
    const input = screen.getByRole('textbox') as HTMLInputElement
    await waitFor(() => {
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe(input.value.length)
    })
  })
})

describe('per-folder create (Fix 4)', () => {
  it('a folder\'s menu offers create, rename and delete; a file\'s offers only rename and delete', () => {
    tree.value = [
      { name: 'notes', path: 'notes', type: 'dir', children: [] },
      { name: 'readme.md', path: 'readme.md', type: 'file' },
    ]
    render(<FileTree onOpenFile={() => {}} />)

    fireEvent.click(screen.getByLabelText('Actions for notes'))
    expect(screen.getByRole('menuitem', { name: 'New file' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'New folder' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByLabelText('Actions for readme.md'))
    expect(screen.queryByRole('menuitem', { name: 'New file' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'New folder' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
  })

  it('new file in a directory: after submitting, the createEntry path includes the directory prefix', async () => {
    const create = vi.spyOn(apiModule.backend, 'createEntry').mockResolvedValue()
    vi.spyOn(apiModule.backend, 'tree').mockResolvedValue([])
    render(<FileTree onOpenFile={() => {}} />)
    rowAction('notes', 'New file')
    const input = await screen.findByRole('textbox')
    fireEvent.input(input, { target: { value: 'sub.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(create).toHaveBeenCalledWith('notes/sub.md', 'file'))
  })

  it('new folder in a directory: after submitting, createEntry is called with the dir type', async () => {
    const create = vi.spyOn(apiModule.backend, 'createEntry').mockResolvedValue()
    vi.spyOn(apiModule.backend, 'tree').mockResolvedValue([])
    render(<FileTree onOpenFile={() => {}} />)
    rowAction('notes', 'New folder')
    const input = await screen.findByRole('textbox')
    fireEvent.input(input, { target: { value: 'subfolder' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(create).toHaveBeenCalledWith('notes/subfolder', 'dir'))
  })
})

describe('outside-click cancel (Fix 5)', () => {
  it('root inline input: cancelPending on document mousedown outside', async () => {
    render(<FileTree onOpenFile={() => {}} />)
    act(() => { startCreate('create-file') })
    expect(pendingOp.value).not.toBeNull()
    // Simulate a mousedown outside the input (on document body)
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(pendingOp.value).toBeNull())
  })

  it('rename inline input: cancelPending on document mousedown outside', async () => {
    tree.value = [{ name: 'a.md', path: 'a.md', type: 'file' }]
    render(<FileTree onOpenFile={() => {}} />)
    rowAction('a.md', 'Rename')
    expect(pendingOp.value).not.toBeNull()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(pendingOp.value).toBeNull())
  })

  it('the Esc key still cancels the pending op', () => {
    render(<FileTree onOpenFile={() => {}} />)
    act(() => { startCreate('create-file') })
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(pendingOp.value).toBeNull()
  })

  it('after submitting with the Enter key, pendingOp is cleared', async () => {
    vi.spyOn(apiModule.backend, 'createEntry').mockResolvedValue()
    vi.spyOn(apiModule.backend, 'tree').mockResolvedValue([])
    render(<FileTree onOpenFile={() => {}} />)
    act(() => { startCreate('create-file') })
    const input = screen.getByRole('textbox')
    fireEvent.input(input, { target: { value: 'test.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(pendingOp.value).toBeNull())
  })
})

describe('refreshTree error handling', () => {
  beforeEach(async () => {
    // Import refreshTree inside the describe so it reads the current signal state
    const { refreshTree } = await import('../../src/web/state/vault.js')
    void refreshTree // keep eslint happy; actual calls are in each test
    treeError.value = null
  })

  it('on success, updates tree and clears treeError', async () => {
    const { refreshTree } = await import('../../src/web/state/vault.js')
    const mockData: VaultEntry[] = [{ name: 'foo.md', path: 'foo.md', type: 'file' }]
    vi.spyOn(apiModule.backend, 'tree').mockResolvedValueOnce(mockData)

    await expect(refreshTree()).resolves.toBeUndefined()
    expect(tree.value).toEqual(mockData)
    expect(treeError.value).toBeNull()
  })

  it('on failure, the promise still resolves, tree keeps its previous value, and treeError is set to a non-null message', async () => {
    const { refreshTree } = await import('../../src/web/state/vault.js')
    const prior = tree.value
    vi.spyOn(apiModule.backend, 'tree').mockRejectedValueOnce(new Error('network error'))

    await expect(refreshTree()).resolves.toBeUndefined()
    expect(tree.value).toBe(prior)
    expect(treeError.value).not.toBeNull()
    // Message must not contain a stack trace or absolute path
    expect(treeError.value).not.toMatch(/\/Users\//)
    expect(treeError.value).not.toMatch(/at \w/)
  })

  it('when a later call succeeds after a failure, treeError is cleared back to null', async () => {
    const { refreshTree } = await import('../../src/web/state/vault.js')
    const mockData: VaultEntry[] = [{ name: 'bar.md', path: 'bar.md', type: 'file' }]
    vi.spyOn(apiModule.backend, 'tree')
      .mockRejectedValueOnce(new Error('oops'))
      .mockResolvedValueOnce(mockData)

    await refreshTree()
    expect(treeError.value).not.toBeNull()

    await refreshTree()
    expect(treeError.value).toBeNull()
    expect(tree.value).toEqual(mockData)
  })
})

/**
 * The pictures folder, and the switch that shows it.
 *
 * Hidden by default because pictures are storage rather than notes — nothing opens one, nothing
 * renames one, and a screenshot per paste would push the notes off the screen within a week. That
 * fails exactly once: when you want a picture *gone*. The switch is the way in, and a dead end is
 * a bug.
 */
describe('the pictures folder', () => {
  const WITH_ASSETS: VaultEntry[] = [
    {
      name: 'assets',
      path: 'assets',
      type: 'dir',
      children: [{ name: '0123456789abcdef.webp', path: 'assets/0123456789abcdef.webp', type: 'file' }],
    },
    ...SAMPLE,
  ]

  beforeEach(() => {
    tree.value = WITH_ASSETS
    setShowAssets(false)
  })

  it('is not in the tree by default', () => {
    render(<FileTree onOpenFile={() => {}} />)
    expect(screen.queryByText('assets')).toBeNull()
    // …and everything else still is.
    expect(screen.getByText('notes')).toBeTruthy()
  })

  it('appears when the switch is on, and goes again when it is off', async () => {
    render(<FileTree onOpenFile={() => {}} />)
    act(() => { setShowAssets(true) })
    await waitFor(() => { expect(screen.getByText('assets')).toBeTruthy() })

    act(() => { setShowAssets(false) })
    await waitFor(() => { expect(screen.queryByText('assets')).toBeNull() })
  })

  it('is remembered, because it is a way of working rather than a moment', () => {
    setShowAssets(true)
    expect(localStorage.getItem('inkstone.showAssets')).toBe('1')
    setShowAssets(false)
    expect(localStorage.getItem('inkstone.showAssets')).toBe('0')
  })

  it('opens a picture in a tab of its own, never in the editor', async () => {
    // Opening one as a note reads its bytes as UTF-8: mojibake, or `not found`. That is what the
    // hidden folder was protecting the reader from, so showing it has to answer for it.
    const opened: string[] = []
    const open = vi.spyOn(window, 'open').mockImplementation(((url: string) => {
      opened.push(String(url)); return null
    }) as typeof window.open)
    const assetUrl = vi.spyOn(apiModule.backend, 'assetUrl').mockResolvedValue('/api/asset?path=x')

    setShowAssets(true)
    const onOpenFile = vi.fn()
    render(<FileTree onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getByText('assets'))
    fireEvent.click(await screen.findByText('0123456789abcdef.webp'))

    await waitFor(() => { expect(opened).toHaveLength(1) })
    expect(assetUrl).toHaveBeenCalledWith('assets/0123456789abcdef.webp')
    expect(onOpenFile).not.toHaveBeenCalled()
    open.mockRestore()
    assetUrl.mockRestore()
  })

  it('says how many notes still use one before it is deleted', async () => {
    const corpus = vi.spyOn(apiModule.backend, 'corpus').mockResolvedValue({
      notes: [
        { path: 'notes/a.md', text: 'see ![](/assets/0123456789abcdef.webp)' },
        { path: 'notes/b.md', text: 'nothing here' },
      ],
      truncated: false,
    })

    setShowAssets(true)
    render(<FileTree onOpenFile={() => {}} />)
    fireEvent.click(screen.getByText('assets'))
    await screen.findByText('0123456789abcdef.webp')
    rowAction('0123456789abcdef.webp', 'Delete')

    expect(await screen.findByText('used in 1 note')).toBeTruthy()
    corpus.mockRestore()
  })
})
