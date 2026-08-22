import type { VaultEntry } from '../../../shared/types.js'

/** One row of `git/trees?recursive=1`, narrowed to what a vault cares about. */
export interface GitTreeItem {
  path: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
}

/**
 * A git tree is flat and a vault is not, so the nesting is rebuilt here.
 *
 * The rules match `src/server/vault/index.ts` exactly, because the tree the user sees must not
 * change depending on which backend is behind it: anything under a dot-segment is skipped, and
 * siblings sort directories first then by name. Submodules (`commit` rows) are skipped for the
 * same reason symlinks are on the server — an entry that cannot be opened does not belong in a
 * list of things to open.
 */
export function buildTree(items: GitTreeItem[]): VaultEntry[] {
  const root: VaultEntry[] = []
  const dirs = new Map<string, VaultEntry>()

  const dirAt = (path: string): VaultEntry[] => {
    if (path === '') return root
    const existing = dirs.get(path)
    if (existing) return existing.children!
    const slash = path.lastIndexOf('/')
    const entry: VaultEntry = {
      name: path.slice(slash + 1),
      path,
      type: 'dir',
      children: [],
    }
    dirs.set(path, entry)
    dirAt(slash === -1 ? '' : path.slice(0, slash)).push(entry)
    return entry.children!
  }

  // Sorted by path so a parent is always created before its children, which lets `dirAt` build
  // missing ancestors without needing a second pass.
  const usable = items
    .filter((item) => item.type === 'blob' || item.type === 'tree')
    .filter((item) => !item.path.split('/').some((segment) => segment.startsWith('.')))
    .sort((a, b) => a.path.localeCompare(b.path))

  for (const item of usable) {
    const slash = item.path.lastIndexOf('/')
    const parent = slash === -1 ? '' : item.path.slice(0, slash)
    if (item.type === 'tree') { dirAt(item.path); continue }
    dirAt(parent).push({ name: item.path.slice(slash + 1), path: item.path, type: 'file' })
  }

  sort(root)
  return root
}

function sort(entries: VaultEntry[]): void {
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const entry of entries) if (entry.children) sort(entry.children)
}

/** Every blob's sha, by path — the lookup `readFile` needs and the rev it hands the app. */
export function blobShas(items: GitTreeItem[]): Map<string, { sha: string; size: number }> {
  const map = new Map<string, { sha: string; size: number }>()
  for (const item of items) {
    if (item.type !== 'blob') continue
    map.set(item.path, { sha: item.sha, size: item.size ?? 0 })
  }
  return map
}

/**
 * The part of a multi-file unified diff that belongs to one path, with the header lines dropped.
 *
 * GitHub hands over a whole commit's diff; the panel shows one file. Splitting here rather than
 * asking for a narrower diff saves a request per file in a range, and the headers go for the same
 * reason they do on the server — `diff --git` and `+++` octal-escape non-ASCII paths, so a CJK
 * filename renders as a line of numbers.
 */
/**
 * The path out of a `diff --git` header, as bytes a person would recognise.
 *
 * git quotes a path that contains anything outside printable ASCII and escapes the bytes in octal:
 * `diff --git "a/OS/\345\234\260..." "b/OS/..."`. Comparing that to a plain string never matches,
 * so every note with a non-Latin name — which here is most of them — had its diff come back empty
 * and the History panel said "No textual change" about every session it had.
 *
 * The escapes are *bytes*, not code points, so they are collected and decoded as UTF-8 together.
 */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw
  const body = raw.slice(1, raw.endsWith('"') ? -1 : undefined)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(...new TextEncoder().encode(body[i]!)); continue }
    const next = body[i + 1]
    if (next !== undefined && next >= '0' && next <= '7') {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8))
      i += 3
      continue
    }
    // The other escapes git uses are the C ones, and they stand for themselves here.
    const simple: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' }
    const ch = next !== undefined ? simple[next] ?? next : ''
    bytes.push(...new TextEncoder().encode(ch))
    i += 1
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** The two paths a `diff --git` header names, unquoted. */
function headerPaths(first: string): { a: string; b: string } | null {
  const rest = first.slice('diff --git '.length)
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest)
  if (quoted) return { a: unquoteGitPath(quoted[1]!).slice(2), b: unquoteGitPath(quoted[2]!).slice(2) }
  const half = rest.indexOf(' b/')
  if (half === -1) return null
  return { a: rest.slice(2, half), b: rest.slice(half + 3) }
}

export function diffForPath(diff: string, path: string): string {
  const blocks = diff.split(/^(?=diff --git )/m)
  const wanted = blocks.find((block) => {
    const first = block.slice(0, block.indexOf('\n'))
    const paths = headerPaths(first)
    return paths !== null && (paths.b === path || paths.a === path)
  })
  if (wanted === undefined) return ''

  const lines = wanted.split('\n')
  const hunk = lines.findIndex((line) => line.startsWith('@@'))
  if (hunk !== -1) return lines.slice(hunk).join('\n').trimEnd()
  return lines
    .filter((line) => !/^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (from|to) )/.test(line))
    .join('\n')
    .trimEnd()
}
