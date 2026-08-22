import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { resolveSafe, VaultPathError } from './paths.js'
import type { SearchMatch } from '../../shared/types.js'
import type { VaultEntry } from '../../shared/types.js'

export type { SearchMatch, VaultEntry } from '../../shared/types.js'

export class VaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultError'
  }
}

export interface FileContent {
  content: string
  mtimeMs: number
}

const ASSET_DIR = 'assets'
const SAFE_EXT = /^[a-z0-9]{1,8}$/i

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

type ErrnoHandler = (relPath: string, err: unknown) => VaultError

const notFound: ErrnoHandler = (relPath, err) =>
  new VaultError(`not found: ${relPath}`, { cause: err })
const alreadyExists: ErrnoHandler = (relPath, err) =>
  new VaultError(`already exists: ${relPath}`, { cause: err })
const notADirectory: ErrnoHandler = (relPath, err) =>
  new VaultError(`path segment is not a directory: ${relPath}`, { cause: err })
const isADirectory: ErrnoHandler = (relPath, err) =>
  new VaultError(`is a directory: ${relPath}`, { cause: err })
const parentMissing: ErrnoHandler = (relPath, err) =>
  new VaultError(`parent directory does not exist: ${relPath}`, { cause: err })
const unexpected: ErrnoHandler = (relPath, err) =>
  new VaultError(`vault operation failed: ${relPath}`, { cause: err })

// mkdir({recursive: true}) hitting a path segment that exists but is not a
// directory may report EEXIST or ENOTDIR depending on the OS/implementation
// (macOS/Linux); both are normalised to "path segment is not a directory".
const SEGMENT_NOT_DIR: Partial<Record<string, ErrnoHandler>> = {
  EEXIST: notADirectory,
  ENOTDIR: notADirectory,
}

/**
 * The single error-translation point: every failure that escapes from here
 * must be a VaultError whose message contains only the caller's own relPath —
 * never the server's absolute path, and never Node's raw errno text (which
 * embeds absolute paths). The original error is kept in `cause` for operators
 * to diagnose from logs.
 *
 * handlers classifies by errno code; any unmatched code falls through to the
 * `unexpected` fallback so no unanticipated fs failure escapes as a bare Error.
 */
async function guardFs<T>(
  op: () => Promise<T>,
  relPath: string,
  handlers: Partial<Record<string, ErrnoHandler>>,
): Promise<T> {
  try {
    return await op()
  } catch (err) {
    const code = errnoCode(err)
    const handler = (code ? handlers[code] : undefined) ?? unexpected
    throw handler(relPath, err)
  }
}

export class Vault {
  constructor(readonly root: string) {}

  async tree(): Promise<VaultEntry[]> {
    return this.#readDir(this.root, '', true)
  }

  /**
   * Every note's text, in one response.
   *
   * Searching used to happen here, once per keystroke, over the network. That is why it felt slow
   * and VS Code does not: those tools search local data. So does this now — the vault is sent to
   * the browser once and searched there, which is instant and has no request to be stale, debounce,
   * or flash. Measured on the real vault: 2,271 bytes, 1,220 gzipped.
   *
   * Capped so a vault that outgrows the idea says so instead of hanging the browser. Hitting the
   * cap is reported, because a search that quietly covers half the notes is worse than one that
   * admits it.
   */
  async corpus(
    { maxTotalBytes = 8 * 1024 * 1024, maxFileBytes = 512 * 1024 } = {},
  ): Promise<{ notes: { path: string; text: string }[]; truncated: boolean }> {
    const notes: { path: string; text: string }[] = []
    let total = 0
    let truncated = false

    const walk = async (absDir: string, relDir: string): Promise<void> => {
      let dirents: Dirent[]
      try {
        dirents = await fs.readdir(absDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const dirent of dirents) {
        if (truncated) return
        if (dirent.name.startsWith('.')) continue
        const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name
        const abs = path.join(absDir, dirent.name)

        if (dirent.isDirectory()) { await walk(abs, rel); continue }
        if (!dirent.isFile() || !dirent.name.endsWith('.md')) continue

        let stat
        try { stat = await fs.stat(abs) } catch { continue }
        if (stat.size > maxFileBytes) continue
        if (total + stat.size > maxTotalBytes) { truncated = true; return }

        try {
          notes.push({ path: rel, text: await fs.readFile(abs, 'utf8') })
          total += stat.size
        } catch { /* unreadable file: skipped, same as the tree does */ }
      }
    }

    await walk(this.root, '')
    return { notes, truncated }
  }

  async #readDir(absDir: string, relDir: string, isRoot: boolean): Promise<VaultEntry[]> {
    let dirents: Dirent[]
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true })
    } catch (err) {
      if (!isRoot) {
        // An unreadable subdirectory must not fail the whole tree; showing it
        // as empty is better than aborting the entire listing.
        return []
      }
      throw unexpected(relDir || '.', err)
    }

    const entries: VaultEntry[] = []

    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name

      if (dirent.isDirectory()) {
        entries.push({
          name: dirent.name,
          path: rel,
          type: 'dir',
          children: await this.#readDir(path.join(absDir, dirent.name), rel, false),
        })
      } else if (dirent.isFile()) {
        entries.push({ name: dirent.name, path: rel, type: 'file' })
      }
      // Symlinks and other types are skipped: entries that cannot be safely resolved are not shown in the tree.
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return entries
  }

  async read(relPath: string): Promise<FileContent> {
    const abs = await resolveSafe(this.root, relPath)
    const stat = await this.#statOrThrow(abs, relPath)
    if (!stat.isFile()) throw new VaultError(`not a file: ${relPath}`)
    const content = await guardFs(() => fs.readFile(abs, 'utf8'), relPath, { ENOENT: notFound })
    return { content, mtimeMs: stat.mtimeMs }
  }

  /**
   * The bytes of a picture, for serving back to the browser.
   *
   * Separate from `read` because that one decodes as UTF-8, which is the right thing for a note
   * and destroys anything else. Nothing here interprets the bytes; the caller says what they are
   * from the extension it asked for.
   */
  async readAsset(relPath: string): Promise<Buffer> {
    const abs = await resolveSafe(this.root, relPath)
    const stat = await this.#statOrThrow(abs, relPath)
    if (!stat.isFile()) throw new VaultError(`not a file: ${relPath}`)
    return guardFs(() => fs.readFile(abs), relPath, { ENOENT: notFound })
  }

  async write(relPath: string, content: string): Promise<{ mtimeMs: number }> {
    const abs = await resolveSafe(this.root, relPath)
    await guardFs(() => fs.mkdir(path.dirname(abs), { recursive: true }), relPath, SEGMENT_NOT_DIR)
    await guardFs(() => fs.writeFile(abs, content, 'utf8'), relPath, { EISDIR: isADirectory })
    const stat = await guardFs(() => fs.stat(abs), relPath, { ENOENT: notFound })
    return { mtimeMs: stat.mtimeMs }
  }

  async createFile(relPath: string): Promise<void> {
    const abs = await resolveSafe(this.root, relPath)
    await guardFs(() => fs.mkdir(path.dirname(abs), { recursive: true }), relPath, SEGMENT_NOT_DIR)
    // wx flag ensures failure if the file already exists — never overwrites.
    await guardFs(
      () => fs.writeFile(abs, '', { encoding: 'utf8', flag: 'wx' }),
      relPath,
      { EEXIST: alreadyExists },
    )
  }

  async createDir(relPath: string): Promise<void> {
    const abs = await resolveSafe(this.root, relPath)
    await guardFs(() => fs.mkdir(abs), relPath, { EEXIST: alreadyExists, ENOENT: parentMissing })
  }

  async rename(from: string, to: string): Promise<void> {
    const absFrom = await resolveSafe(this.root, from)
    const absTo = await resolveSafe(this.root, to)
    await this.#statOrThrow(absFrom, from)

    if (await this.#exists(absTo)) {
      throw new VaultError(`target already exists: ${to}`)
    }
    await guardFs(() => fs.mkdir(path.dirname(absTo), { recursive: true }), to, SEGMENT_NOT_DIR)
    await guardFs(() => fs.rename(absFrom, absTo), from, {})
  }

  async remove(relPath: string): Promise<void> {
    const abs = await resolveSafe(this.root, relPath)
    await this.#statOrThrow(abs, relPath)
    await guardFs(() => fs.rm(abs, { recursive: true, force: false }), relPath, {})
  }

  /**
   * Write a picture into `assets/`, named for its own bytes.
   *
   * Nothing but the bytes goes into the name, which is what makes it pure content addressing: the
   * same picture pasted into two notes is written once and linked twice, and a name can never come
   * to mean different bytes — which is what lets it be served `immutable` rather than revalidated.
   *
   * The same digest, to the same length, as the browser computes in `web/assets/encode.ts`, so a
   * vault and the GitHub repository behind it call the same picture the same thing.
   *
   * A second write of a picture already here is not performed at all. It would produce identical
   * bytes, but it would touch the mtime, and the watcher would announce a change that did not
   * happen — and `existed` is how the reader gets told nothing was written.
   */
  async writeAsset(bytes: Buffer, ext: string): Promise<{ path: string; existed: boolean }> {
    if (!SAFE_EXT.test(ext)) {
      throw new VaultError(`unsafe asset extension: ${ext}`)
    }
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const rel = `${ASSET_DIR}/${digest}.${ext.toLowerCase()}`
    const abs = await resolveSafe(this.root, rel)
    if (await this.#exists(abs)) return { path: rel, existed: true }
    await guardFs(() => fs.mkdir(path.dirname(abs), { recursive: true }), rel, SEGMENT_NOT_DIR)
    await guardFs(() => fs.writeFile(abs, bytes), rel, {})
    return { path: rel, existed: false }
  }

  async #statOrThrow(abs: string, relPath: string) {
    return guardFs(() => fs.stat(abs), relPath, { ENOENT: notFound })
  }

  async #exists(abs: string): Promise<boolean> {
    try {
      await fs.stat(abs)
      return true
    } catch {
      return false
    }
  }
}

export { VaultPathError }
