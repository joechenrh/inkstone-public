import { signal } from '@preact/signals'
import type { Signal } from '@preact/signals'
import { pruneRecent } from './recent.js'
import { invalidateCorpus } from './search.js'
import type { VaultEntry } from '../../shared/types.js'
import { backend } from '../api/index.js'
import { setSidebarView } from './ui.js'

/**
 * The vault's tree, or **null while it has never been read**.
 *
 * An empty array is an assertion — this vault has no notes — and it must not be made before
 * anyone has looked. It was the initial value, so "No notes yet" was on screen for every load:
 * 21ms on a local disk, 478ms over a 500ms round trip, and two round trips over GitHub.
 */
export const tree = signal<VaultEntry[] | null>(null)
export const currentPath = signal<string | null>(null)
export const expandedDirs = signal<Set<string>>(new Set())
export const treeError = signal<string | null>(null)

/**
 * Whether the vault has this note, without reading it.
 *
 * A link that points at nothing has to be told apart from one that points at something slow, and
 * the tree is already in memory. Null while the tree has never been read, in which case the answer
 * is "assume it is there" — refusing to follow a link because a list has not arrived would be a
 * worse guess than trying and failing.
 */
export function treeHas(path: string): boolean {
  const entries = tree.value
  if (entries === null) return true
  const walk = (list: VaultEntry[]): boolean => list.some(
    (e) => (e.type === 'file' && e.path === path) || (e.children ? walk(e.children) : false),
  )
  return walk(entries)
}

export type PendingOp =
  | { kind: 'create-file' | 'create-dir'; parent: string }
  | { kind: 'rename'; path: string; initialName: string }

export const pendingOp: Signal<PendingOp | null> = signal<PendingOp | null>(null)

export async function refreshTree(): Promise<void> {
  // Anything that changes the tree can change the text, and the search copy must not outlive it.
  invalidateCorpus()
  try {
    tree.value = await backend.tree()
    // Files deleted or renamed anywhere — in the app, on disk, or by a git checkout — should
    // not linger in the recent list and open onto a 404.
    pruneRecent(tree.value ?? [])
    treeError.value = null
  } catch {
    treeError.value = 'Failed to load file list'
  }
}

export function isExpanded(path: string): boolean {
  return expandedDirs.value.has(path)
}

export function toggleDir(path: string): void {
  // Copy into a new Set: signals trigger re-render on reference change; mutating in place won't update the UI
  const next = new Set(expandedDirs.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expandedDirs.value = next
}

/** When opening a file, expand all of its ancestor directories. */
export function expandAncestors(filePath: string): void {
  const segments = filePath.split('/')
  const next = new Set(expandedDirs.value)
  for (let i = 1; i < segments.length; i += 1) {
    next.add(segments.slice(0, i).join('/'))
  }
  expandedDirs.value = next
}

/** Recursively find the VaultEntry matching path */
function findEntry(entries: VaultEntry[], path: string): VaultEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry
    if (entry.type === 'dir' && entry.children) {
      const found = findEntry(entry.children, path)
      if (found) return found
    }
  }
  return null
}

/** Return the directory path the currently selected entry belongs to (empty string means root) */
function targetDir(): string {
  const p = currentPath.value
  if (!p) return ''
  const entry = findEntry(tree.value ?? [], p)
  if (entry?.type === 'dir') return p
  const slash = p.lastIndexOf('/')
  return slash === -1 ? '' : p.slice(0, slash)
}

export function startCreate(kind: 'create-file' | 'create-dir'): void {
  const parent = targetDir()
  pendingOp.value = { kind, parent }
  // Auto-expand the target directory so the inline input is visible
  if (parent !== '') {
    const next = new Set(expandedDirs.value)
    next.add(parent)
    expandedDirs.value = next
  }
}

/**
 * Begin creating a note or folder from somewhere outside the file tree.
 *
 * The name is typed into an inline input that lives *in* the tree, and the tree is unmounted
 * whenever the sidebar shows the outline or is collapsed — so the view has to be switched first or
 * the action silently does nothing. Both the empty editor's rows and the Cmd+Alt+N/F shortcuts go
 * through here for that reason.
 */
export function beginCreate(kind: 'create-file' | 'create-dir'): void {
  setSidebarView('files')
  startCreate(kind)
}

/** Start a create operation targeting an explicit directory path (for per-folder create buttons). */
export function startCreateIn(kind: 'create-file' | 'create-dir', parentPath: string): void {
  pendingOp.value = { kind, parent: parentPath }
  // Auto-expand the target directory so the inline input appears beneath it
  const next = new Set(expandedDirs.value)
  next.add(parentPath)
  expandedDirs.value = next
}

export function startRename(path: string): void {
  const name = path.slice(path.lastIndexOf('/') + 1)
  pendingOp.value = { kind: 'rename', path, initialName: name }
}

export function cancelPending(): void {
  pendingOp.value = null
}

export async function commitCreate(name: string): Promise<void> {
  const op = pendingOp.value
  if (!op || op.kind === 'rename' || !name.trim()) {
    pendingOp.value = null
    return
  }
  const path = op.parent ? `${op.parent}/${name}` : name
  pendingOp.value = null
  try {
    await backend.createEntry(path, op.kind === 'create-dir' ? 'dir' : 'file')
    await refreshTree()
    if (op.kind === 'create-file') {
      const { openFile } = await import('./document.js')
      await openFile(path)
    }
  } catch {
    treeError.value = 'Failed to create'
  }
}

export async function commitRename(name: string): Promise<void> {
  const op = pendingOp.value
  if (!op || op.kind !== 'rename' || !name.trim()) {
    pendingOp.value = null
    return
  }
  const slash = op.path.lastIndexOf('/')
  const to = slash === -1 ? name : `${op.path.slice(0, slash)}/${name}`
  pendingOp.value = null
  try {
    await backend.rename(op.path, to)
    if (currentPath.value === op.path) currentPath.value = to
    await refreshTree()
  } catch {
    treeError.value = 'Failed to rename'
  }
}

export async function deleteEntry(path: string): Promise<void> {
  try {
    await backend.remove(path)
    if (currentPath.value === path) {
      const { closeDocument } = await import('./document.js')
      currentPath.value = null
      closeDocument(path)
    }
    await refreshTree()
  } catch {
    treeError.value = 'Failed to delete'
  }
}
