import { signal } from '@preact/signals'
import type { VaultEntry } from '../../shared/types.js'

const KEY = 'inkstone.recent'
const LIMIT = 8

/**
 * Recently opened notes, most recent first.
 *
 * Client-side on purpose: the tree API carries no mtime, and "recently opened by me" is a better
 * answer for an empty editor than "recently modified on disk" anyway — a sync or a git checkout
 * would reshuffle the latter without you having touched anything.
 */
export const recentPaths = signal<string[]>(read())

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, LIMIT) : []
  } catch {
    return [] // unparseable or storage denied — an empty history is not worth an error
  }
}

function write(paths: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(paths)) } catch { /* storage denied */ }
}

export function recordRecent(path: string): void {
  const next = [path, ...recentPaths.value.filter((p) => p !== path)].slice(0, LIMIT)
  recentPaths.value = next
  write(next)
}

export function forgetRecent(path: string): void {
  const next = recentPaths.value.filter((p) => p !== path && !p.startsWith(`${path}/`))
  if (next.length === recentPaths.value.length) return
  recentPaths.value = next
  write(next)
}

/** Every file path in the tree, so entries for deleted or renamed files can be dropped. */
function filePaths(entries: VaultEntry[], into: Set<string> = new Set()): Set<string> {
  for (const e of entries) {
    if (e.type === 'file') into.add(e.path)
    if (e.children) filePaths(e.children, into)
  }
  return into
}

/**
 * Drop entries that no longer exist. The tree arrives after the recent list is read from storage,
 * and files can also vanish outside the app, so this runs whenever the tree changes rather than
 * once at startup.
 */
export function pruneRecent(entries: VaultEntry[]): void {
  if (entries.length === 0) return // tree not loaded yet; pruning now would clear the whole list
  const known = filePaths(entries)
  const next = recentPaths.value.filter((p) => known.has(p))
  if (next.length === recentPaths.value.length) return
  recentPaths.value = next
  write(next)
}
