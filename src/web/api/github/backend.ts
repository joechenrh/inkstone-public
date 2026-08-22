import type { FileCommit, PendingChange, VaultEntry } from '../../../shared/types.js'
import {
  BackendError,
  ConflictError,
  type FileSnapshot,
  type GitStatus,
  type Rev,
  type VaultBackend,
  type WriteResult,
} from '../backend.js'
import { diffText, diffWholeFile } from './diff.js'
import { DIFF, GitHubRest, RAW, type RestOptions } from './rest.js'
import { WorkingStore } from './store.js'
import { hashName } from '../../assets/encode.js'
import { blobShas, buildTree, diffForPath, type GitTreeItem } from './tree.js'

export interface GitHubBackendOptions extends RestOptions {
  owner: string
  repo: string
  /** The branch being edited. */
  ref: string
  /** How often to commit unattended, matching the server's five minutes. 0 turns it off. */
  autocommitMs?: number
  /** Injectable so a test does not wait five minutes to prove the timer exists. */
  setInterval?: (fn: () => void, ms: number) => unknown
  /**
   * Called after any commit lands, including the unattended ones.
   *
   * A commit folds the working store's writes into a new base, so the rev the open document is
   * holding stops existing. The manual path knew that and re-pointed the document afterwards; the
   * timer did not, so a save, an autocommit, and a second save reported "This file was changed on
   * disk" — about the reader's own text, committed by the reader's own editor. Announcing it here
   * means there is one place a commit is known to have happened, whoever asked for it.
   */
  onCommitted?: () => void
  now?: () => number
}

/** The directory every picture goes in, matching the vault route's. */
const ASSET_DIR = 'assets'

const ASSET_TYPES: Record<string, string> = {
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', avif: 'image/avif',
}

function assetType(path: string): string {
  return ASSET_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** Base64 in chunks, so a large picture cannot blow the argument stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s/g, ''))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Matches the server's corpus limits, so search behaves the same behind either backend. */
const MAX_CORPUS_BYTES = 8 * 1024 * 1024
const MAX_NOTE_BYTES = 512 * 1024
/** How many blobs to have in flight at once. Enough to be quick, few enough to stay polite. */
const FETCH_WIDTH = 8
const AUTOCOMMIT_MS = 5 * 60 * 1000
/** How many filenames an unattended commit names before it starts counting instead. */
const MAX_FILES_IN_MESSAGE = 3
/** A regular file. Everything this app writes is one. */
const BLOB_MODE = '100644'

/**
 * A vault that is a branch of a GitHub repository, edited straight from the browser.
 *
 * The shape above the seam is the one this app has always had: **save is not commit.** Ctrl+S puts
 * text in the working store, the commit panel shows what is in it, and one commit carries all of
 * it. That last part is the whole reason this is not a commit per keystroke — GitHub's Contents
 * API takes one file per commit, and the Git Data API used here takes as many as there are.
 *
 * Revs are blob shas for committed text and `local:` counters for text that is only in the store.
 * Either way they are opaque above here, and equal exactly when the version is the same.
 */
export function createGitHubBackend(options: GitHubBackendOptions): VaultBackend {
  const { owner, repo, ref } = options
  const rest = new GitHubRest(options)
  const store = new WorkingStore({ owner, repo, ref })
  const now = options.now ?? (() => Date.now())
  const repoPath = `/repos/${owner}/${repo}`

  /** The base tree, as GitHub last described it. Null until read, and again after every commit. */
  let items: GitTreeItem[] | null = null
  /** Blob text by sha. A sha names bytes that never change, so this can never be stale. */
  const blobs = new Map<string, string>()

  async function loadBase(): Promise<GitTreeItem[]> {
    if (items !== null) return items
    const head = await rest.request<{ object: { sha: string } }>(
      `${repoPath}/git/ref/heads/${encodeURIComponent(ref)}`,
    )
    const tree = await rest.request<{ sha: string; tree: GitTreeItem[]; truncated: boolean }>(
      `${repoPath}/git/trees/${head.object.sha}?recursive=1`,
    )
    if (tree.truncated) {
      // GitHub stops at ~100k entries or 7MB of listing. Showing part of a vault as if it were
      // the whole vault is worse than saying so.
      throw new BackendError('This repository is too large to list in one request', 422)
    }
    // Whatever is uncommitted survives this: a store entry says what a path's content should be,
    // which stays meaningful against a newer tree. Dropping them would delete the user's work to
    // keep the bookkeeping tidy.
    store.setBase(head.object.sha, tree.sha)
    items = tree.tree
    return items
  }

  async function baseShas(): Promise<Map<string, { sha: string; size: number }>> {
    return blobShas(await loadBase())
  }

  async function blobText(sha: string): Promise<string> {
    const cached = blobs.get(sha)
    if (cached !== undefined) return cached
    const text = await rest.request<string>(`${repoPath}/git/blobs/${sha}`, { accept: RAW })
    blobs.set(sha, text)
    return text
  }

  /** The committed text of a path, or null when the base has no such file. */
  async function baseText(path: string): Promise<string | null> {
    const entry = (await baseShas()).get(path)
    return entry === undefined ? null : blobText(entry.sha)
  }

  /** Every path the vault has right now, base and store merged. The tree is built from this. */
  async function overlay(): Promise<{ files: Set<string>; dirs: Set<string> }> {
    const files = new Set<string>((await baseShas()).keys())
    const dirs = new Set<string>()
    for (const item of await loadBase()) if (item.type === 'tree') dirs.add(item.path)

    for (const [path, entry] of store.entries()) {
      if (entry.kind === 'write' || entry.kind === 'asset') files.add(path)
      else if (entry.kind === 'delete') files.delete(path)
      else dirs.add(path)
    }
    return { files, dirs }
  }

  /** Paths inside a directory, which is what renaming or deleting one has to act on. */
  async function childrenOf(dir: string): Promise<string[]> {
    const { files } = await overlay()
    return [...files].filter((p) => p.startsWith(`${dir}/`)).sort()
  }

  /** True for a path the base has never had, whose deletion is a forget rather than a tombstone. */
  async function isLocalOnly(path: string): Promise<boolean> {
    return !(await baseShas()).has(path)
  }

  async function readPath(path: string): Promise<FileSnapshot> {
    const entry = store.get(path)
    if (entry?.kind === 'write') {
      return { path, content: entry.content, rev: entry.rev, modifiedAt: entry.at }
    }
    if (entry?.kind === 'delete') throw new BackendError(`not found: ${path}`, 404)

    const base = (await baseShas()).get(path)
    if (base === undefined) throw new BackendError(`not found: ${path}`, 404)
    // A blob carries no date. For committed text History's list is where "when" lives, and the
    // "Modified" line reads "—" rather than inventing one.
    return { path, content: await blobText(base.sha), rev: base.sha, modifiedAt: null }
  }

  /**
   * Pictures, by blob sha.
   *
   * Two maps rather than one: the bytes are what a fetch costs and the object URL is what the DOM
   * needs, and a URL handed out twice for the same sha is one blob the browser keeps alive rather
   * than two. Both live as long as this backend does — which is one repository in one tab.
   */
  const assetBytes = new Map<string, Uint8Array>()
  const assetUrls = new Map<string, string>()

  /**
   * And the same thing on disk, so a reload does not re-download the pictures.
   *
   * The blob is fetched from `api.github.com` with an `Authorization` header, so no URL cache can
   * help — this is the one place the bytes have to be kept by hand. Keyed by sha, for the reason
   * above; a Cache entry needs a URL, so the sha is spelled as one against a host that cannot
   * exist. Nothing is ever evicted by us, because nothing here can go stale.
   *
   * Absent in a test and on a page that is not a secure context, and everything still works — one
   * fetch per sha per session instead of one per sha ever.
   */
  const CACHE = 'inkstone-assets'
  const cacheKey = (sha: string) => `https://asset.inkstone.invalid/${sha}`
  const shaCache = async (): Promise<Cache | null> => {
    if (typeof caches === 'undefined') return null
    try {
      return await caches.open(CACHE)
    } catch {
      return null
    }
  }

  async function stored(sha: string): Promise<Uint8Array | undefined> {
    const cache = await shaCache()
    const hit = await cache?.match(cacheKey(sha))
    if (hit === undefined || hit === null) return undefined
    return new Uint8Array(await hit.arrayBuffer())
  }

  async function keep(sha: string, bytes: Uint8Array, type: string): Promise<void> {
    const cache = await shaCache()
    try {
      await cache?.put(cacheKey(sha), new Response(bytes as unknown as BodyInit, {
        headers: { 'content-type': type },
      }))
    } catch {
      // A full or disabled cache is not a reason a picture should fail to show.
    }
  }

  /** A path's rev as things stand, for the optimistic lock. */
  async function currentRev(path: string): Promise<Rev | null> {
    const entry = store.get(path)
    if (entry?.kind === 'write') return entry.rev
    if (entry?.kind === 'delete') return null
    return (await baseShas()).get(path)?.sha ?? null
  }

  /** The changed files, each with the diff it would contribute to a commit. */
  async function pending(): Promise<PendingChange[]> {
    const base = await baseShas()
    const changes: PendingChange[] = []

    for (const [path, entry] of store.entries()) {
      if (entry.kind === 'dir') continue

      if (entry.kind === 'asset') {
        // A picture has no diff. `git status` would call it a new binary file and show no lines,
        // and counting characters of base64 at a reader would be worse than saying nothing.
        if (base.has(path)) continue
        changes.push({ path, status: 'added', added: 0, removed: 0, diff: '' })
        continue
      }

      if (entry.kind === 'delete') {
        const before = await baseText(path)
        if (before === null) continue
        const { text, added, removed } = diffWholeFile(before, 'deleted')
        changes.push({ path, status: 'deleted', added, removed, diff: text })
        continue
      }

      if (!base.has(path)) {
        const { text, added, removed } = diffWholeFile(entry.content, 'added')
        changes.push({ path, status: 'added', added, removed, diff: text })
        continue
      }

      const before = (await baseText(path))!
      // Saved, then edited back to what was committed. Not a change, and git would not call it one.
      if (before === entry.content) continue
      const { text, added, removed } = diffText(before, entry.content)
      changes.push({ path, status: 'modified', added, removed, diff: text })
    }

    // Codepoint order, which is the order git lists a status in — not the tree's `localeCompare`,
    // which exists to put a file list in front of a person.
    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return changes
  }

  function autosaveMessage(files: string[]): string {
    const shown = files.slice(0, MAX_FILES_IN_MESSAGE).join(', ')
    const extra = files.length - MAX_FILES_IN_MESSAGE
    return extra > 0 ? `autosave: ${shown} (+${extra} more)` : `autosave: ${shown}`
  }

  async function doCommit(message: string): Promise<{ sha: string; files: string[] } | null> {
    await loadBase()
    const changes = await pending()
    if (changes.length === 0) return null

    // One blob per changed file. GitHub returns the same sha for identical content, so uploading
    // one that already exists costs a request and nothing else.
    const tree: { path: string; mode: string; type: 'blob'; sha: string | null }[] = []
    for (const change of changes) {
      if (change.status === 'deleted') {
        tree.push({ path: change.path, mode: BLOB_MODE, type: 'blob', sha: null })
        continue
      }
      const entry = store.get(change.path)
      // The picture's bytes went to GitHub when it was pasted, as a blob nothing referenced. There
      // is nothing to upload now — the tree just points at it, and the object stops being garbage.
      if (entry?.kind === 'asset') {
        tree.push({ path: change.path, mode: BLOB_MODE, type: 'blob', sha: entry.sha })
        continue
      }
      if (entry?.kind !== 'write') continue
      const blob = await rest.request<{ sha: string }>(`${repoPath}/git/blobs`, {
        method: 'POST',
        body: { content: entry.content, encoding: 'utf-8' },
      })
      blobs.set(blob.sha, entry.content)
      tree.push({ path: change.path, mode: BLOB_MODE, type: 'blob', sha: blob.sha })
    }

    // One tree and one commit whatever the file count. The difference between this and the
    // Contents API is the whole reason the history stays readable.
    const newTree = await rest.request<{ sha: string }>(`${repoPath}/git/trees`, {
      method: 'POST',
      body: { base_tree: store.baseTreeSha, tree },
    })
    const commit = await rest.request<{ sha: string }>(`${repoPath}/git/commits`, {
      method: 'POST',
      body: {
        message: message === '' ? autosaveMessage(changes.map((c) => c.path)) : message,
        tree: newTree.sha,
        parents: [store.baseCommitSha],
      },
    })

    try {
      await rest.request(`${repoPath}/git/refs/heads/${encodeURIComponent(ref)}`, {
        method: 'PATCH',
        body: { sha: commit.sha, force: false },
      })
    } catch (err) {
      // The branch moved while this was being assembled. Nothing is lost — the store still holds
      // every edit — but taking the branch anyway would overwrite whatever arrived. So the base is
      // refreshed and the choice handed back: pressing Commit again means "mine wins", said
      // deliberately, against a panel showing the diffs as they now stand.
      if (err instanceof BackendError && (err.status === 422 || err.status === 409)) {
        items = null
        await loadBase()
        throw new BackendError(
          `${ref} moved on GitHub. Your changes are still here — the panel now shows them against the new version.`,
          409,
        )
      }
      throw err
    }

    store.rebase(commit.sha, newTree.sha)
    items = null
    options.onCommitted?.()
    return { sha: commit.sha, files: changes.map((c) => c.path) }
  }

  if (options.autocommitMs !== 0) {
    const schedule = options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
    schedule(() => {
      if (store.isEmpty) return
      // Unattended: a failure here is not a press waiting to hear back, and the next tick or an
      // explicit commit will say so.
      void doCommit('').catch(() => {})
    }, options.autocommitMs ?? AUTOCOMMIT_MS)
  }

  return {
    async info(): Promise<{ label: string }> {
      return { label: `${owner}/${repo}` }
    },

    connect(): () => void {
      // Nothing pushes: GitHub has no channel to this browser. A branch that moved underneath is
      // found at commit, where the ref update is refused — late, but in the one place where a
      // choice can be offered about it.
      return () => {}
    },

    isSameRev(a: Rev | null, b: Rev | null): boolean {
      return a !== null && a === b
    },

    async tree(): Promise<VaultEntry[]> {
      const { files, dirs } = await overlay()
      // The pictures are in here. Whether they are *drawn* is a question for the browser, where the
      // switch is — a tree that dropped them could never show them again, whatever the switch said.
      return buildTree([
        ...[...dirs].map((path) => ({ path, type: 'tree' as const, sha: '' })),
        ...[...files].map((path) => ({ path, type: 'blob' as const, sha: '' })),
      ])
    },

    readFile(path: string): Promise<FileSnapshot> {
      return readPath(path)
    },

    async writeFile(path: string, content: string, base?: Rev): Promise<WriteResult> {
      const current = await currentRev(path)
      if (base !== undefined && current !== null && base !== current) {
        throw new ConflictError('the file has changed', await readPath(path))
      }
      const at = now()
      return { rev: store.write(path, content, at), modifiedAt: at }
    },

    async createEntry(path: string, kind: 'file' | 'dir'): Promise<void> {
      const { files, dirs } = await overlay()
      if (files.has(path) || dirs.has(path)) throw new BackendError(`already exists: ${path}`, 409)
      if (kind === 'dir') store.makeDir(path)
      else store.write(path, '', now())
    },

    async rename(from: string, to: string): Promise<void> {
      const { files, dirs } = await overlay()
      if (files.has(to) || dirs.has(to)) throw new BackendError(`already exists: ${to}`, 409)

      if (dirs.has(from)) {
        // A directory is not a thing in a git tree, so renaming one means moving what is under it.
        for (const child of await childrenOf(from)) {
          const snapshot = await readPath(child)
          store.write(`${to}${child.slice(from.length)}`, snapshot.content, now())
          store.remove(child, !(await isLocalOnly(child)))
        }
        store.forget(from)
        store.makeDir(to)
        return
      }

      if (!files.has(from)) throw new BackendError(`not found: ${from}`, 404)
      const snapshot = await readPath(from)
      const local = await isLocalOnly(from)
      store.write(to, snapshot.content, now())
      store.remove(from, !local)
    },

    async remove(path: string): Promise<void> {
      const { files, dirs } = await overlay()
      if (dirs.has(path)) {
        for (const child of await childrenOf(path)) store.remove(child, !(await isLocalOnly(child)))
        store.forget(path)
        return
      }
      if (!files.has(path)) throw new BackendError(`not found: ${path}`, 404)
      store.remove(path, !(await isLocalOnly(path)))
    },

    async corpus(): Promise<{ notes: { path: string; text: string }[]; truncated: boolean }> {
      const base = await baseShas()
      const { files } = await overlay()
      const notes: { path: string; text: string }[] = []
      const toFetch: { path: string; sha: string }[] = []
      let total = 0
      let truncated = false

      for (const path of [...files].sort()) {
        if (!path.endsWith('.md')) continue
        if (path.split('/').some((segment) => segment.startsWith('.'))) continue

        const entry = store.get(path)
        if (entry?.kind === 'write') {
          // Text that is saved but not committed is text search has to find, or search answers
          // about a version of the vault nobody is looking at.
          const size = entry.content.length
          if (size > MAX_NOTE_BYTES) continue
          if (total + size > MAX_CORPUS_BYTES) { truncated = true; break }
          total += size
          notes.push({ path, text: entry.content })
          continue
        }

        const blob = base.get(path)
        if (blob === undefined) continue
        if (blob.size > MAX_NOTE_BYTES) continue
        if (total + blob.size > MAX_CORPUS_BYTES) { truncated = true; break }
        total += blob.size
        toFetch.push({ path, sha: blob.sha })
      }

      // One request per note, because the tarball shortcut does not survive CORS. The blob cache
      // is what keeps this from happening twice.
      for (let i = 0; i < toFetch.length; i += FETCH_WIDTH) {
        const slice = toFetch.slice(i, i + FETCH_WIDTH)
        const texts = await Promise.all(slice.map((w) => blobText(w.sha).catch(() => null)))
        slice.forEach((w, n) => {
          const text = texts[n]
          if (text != null) notes.push({ path: w.path, text })
        })
      }
      notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      return { notes, truncated }
    },

    async gitStatus(): Promise<GitStatus> {
      // `ahead` is always zero, and that is not a stub: a commit here lands on the branch, so
      // there is no local history to be ahead of a remote with. Both push controls are gated on
      // it and disappear on their own.
      return { dirty: !store.isEmpty, branch: ref, hasRemote: true, ahead: 0 }
    },

    async gitChanges(): Promise<{ changes: PendingChange[] }> {
      await loadBase()
      return { changes: await pending() }
    },

    commit(message: string): Promise<{ sha: string; files: string[] } | null> {
      return doCommit(message)
    },

    async push(): Promise<{ pushed: number }> {
      // Committing already published. Kept so the interface is whole; unreachable from the app.
      return { pushed: 0 }
    },

    /**
     * Send the bytes now, and reference them later.
     *
     * `POST /git/blobs` creates an object that no tree and no commit points at. It costs one
     * request, it is invisible in the history, and GitHub garbage-collects a blob nothing ever
     * refers to — so a paste that is never committed leaves nothing behind. The store keeps the
     * sha and the path, about sixty bytes, because it is `localStorage` and a screenshot would
     * eat the budget the notes live in.
     */
    async writeAsset(bytes: Uint8Array, ext: string): Promise<{ path: string; existed: boolean }> {
      const path = `${ASSET_DIR}/${await hashName(bytes, ext)}`

      // Named for its own bytes, so if it is already here it is already the same picture.
      const existing = store.get(path)
      if (existing?.kind === 'asset') return { path, existed: true }
      if ((await baseShas()).has(path)) return { path, existed: true }

      const blob = await rest.request<{ sha: string }>(`${repoPath}/git/blobs`, {
        method: 'POST',
        body: { content: toBase64(bytes), encoding: 'base64' },
      })
      assetBytes.set(blob.sha, bytes)
      void keep(blob.sha, bytes, assetType(path))
      store.putAsset(path, blob.sha, now())
      return { path, existed: false }
    },

    /**
     * A URL for `src`, from a path a note refers to.
     *
     * Cached by **sha**, never by path: a path is only a name, and the same name can mean different
     * bytes on another branch or after a revert. An entry keyed by sha is true for ever and can
     * never go stale, so nothing here needs invalidating — which is the other half of why the hash
     * is in the filename.
     */
    async assetUrl(path: string): Promise<string | null> {
      const rel = path.replace(/^\//, '')
      if (!rel.startsWith(`${ASSET_DIR}/`)) return null

      const entry = store.get(rel)
      const sha = entry?.kind === 'asset' ? entry.sha : (await baseShas()).get(rel)?.sha
      if (sha === undefined) return null

      const known = assetUrls.get(sha)
      if (known !== undefined) return known

      const type = assetType(rel)
      let bytes = assetBytes.get(sha) ?? await stored(sha)
      if (bytes === undefined) {
        const base64 = await rest.request<{ content: string }>(`${repoPath}/git/blobs/${sha}`)
        bytes = fromBase64(base64.content)
        void keep(sha, bytes, type)
      }
      assetBytes.set(sha, bytes)
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }))
      assetUrls.set(sha, url)
      return url
    },

    releaseAssets(): void {
      for (const url of assetUrls.values()) URL.revokeObjectURL(url)
      assetUrls.clear()
      // The bytes go too. They are on disk in the Cache and on GitHub as a blob, and holding a
      // megabyte of screenshots for a note nobody is reading is the thing this exists to stop.
      assetBytes.clear()
    },

    async gitLog(path: string, limit = 100): Promise<{ commits: FileCommit[] }> {
      const raw = await rest.request<{
        sha: string
        commit: { message: string; author: { date: string } | null; committer: { date: string } | null }
      }[]>(`${repoPath}/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&per_page=${limit}`)

      return {
        commits: raw.map((c) => ({
          sha: c.sha,
          date: c.commit.author?.date ?? c.commit.committer?.date ?? '',
          message: c.commit.message.split('\n')[0] ?? '',
          // The list endpoint carries no per-file counts, and asking for them would be one request
          // per row. `null` rather than `0`: the panel hides both, but only one of them is a claim
          // that nothing changed.
          added: null,
          removed: null,
        })),
      }
    },

    async gitDiff(path: string, from: string | null, to: string): Promise<{ diff: string }> {
      const url = from === null
        ? `${repoPath}/commits/${to}`
        : `${repoPath}/compare/${from}...${to}`
      const diff = await rest.request<string>(url, { accept: DIFF })
      return { diff: diffForPath(diff, path) }
    },

    async fileAtCommit(path: string, sha: string): Promise<{ content: string }> {
      const content = await rest.request<string>(
        `${repoPath}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(sha)}`,
        { accept: RAW },
      )
      return { content }
    },
  }
}
