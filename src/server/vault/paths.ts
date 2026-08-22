import fs from 'node:fs/promises'
import path from 'node:path'

export class VaultPathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultPathError'
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Runs realpath on the deepest existing ancestor, then appends the remaining
 * non-existent segments back. This allows new files to also receive a
 * canonical path free of symlinks.
 */
async function realpathDeepest(target: string): Promise<string> {
  const tail: string[] = []
  let cursor = target

  for (;;) {
    try {
      const real = await fs.realpath(cursor)
      return tail.length === 0 ? real : path.join(real, ...tail.reverse())
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      const parent = path.dirname(cursor)
      if (parent === cursor) throw new VaultPathError('cannot resolve path')
      tail.push(path.basename(cursor))
      cursor = parent
    }
  }
}

/**
 * Resolves a user-supplied relative path to an absolute path inside the vault.
 * Rejects all forms of escape: absolute paths, .. traversal, NUL bytes, and
 * symlinks that resolve outside the root. Does not perform URL-decoding — the
 * HTTP layer has already decoded once; decoding again would open a new
 * traversal surface.
 */
export async function resolveSafe(root: string, relPath: string): Promise<string> {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new VaultPathError('path must be a non-empty string')
  }
  if (relPath.includes('\0')) {
    throw new VaultPathError('path contains NUL byte')
  }
  if (path.isAbsolute(relPath)) {
    throw new VaultPathError('absolute paths are rejected')
  }

  const target = path.resolve(root, relPath)

  if (!isInside(root, target)) {
    throw new VaultPathError(`path escapes vault root: ${relPath}`)
  }

  let rootReal: string
  try {
    rootReal = await fs.realpath(root)
  } catch (err) {
    // A missing/unreadable vault root is an operator misconfiguration, not
    // attacker-controlled input — give it a distinct message from the
    // traversal-rejection cases below, and never echo an absolute path.
    throw new VaultPathError('vault root is not accessible', { cause: err })
  }

  let real: string
  try {
    real = await realpathDeepest(target)
  } catch (err) {
    if (err instanceof VaultPathError) throw err
    // Any other errno (e.g. ELOOP from a symlink cycle) must not escape as a
    // raw Error: Node's fs error messages embed the full absolute path being
    // resolved, which would leak the server's filesystem layout. Echo only
    // the caller's own relPath, and keep the original error as `cause` for
    // operators debugging from logs.
    throw new VaultPathError(`path could not be resolved: ${relPath}`, { cause: err })
  }

  if (!isInside(rootReal, real)) {
    throw new VaultPathError(`path resolves outside vault root via symlink: ${relPath}`)
  }

  return target
}
