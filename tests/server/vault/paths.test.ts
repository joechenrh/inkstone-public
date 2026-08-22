import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveSafe, VaultPathError } from '../../../src/server/vault/paths.js'

let root: string
let outside: string
let base: string

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-paths-'))
  root = path.join(base, 'vault')
  outside = path.join(base, 'outside')
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(root, 'notes', 'a.md'), '# a')
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret')
  await fs.symlink(outside, path.join(root, 'escape-link'))
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'secret-link.txt'))
  // cycle-a <-> cycle-b: a symlink cycle entirely inside the vault, for the ELOOP
  // error-leak test. Named to avoid colliding with the existing 'a/b/c/new.md' fixture.
  await fs.symlink(path.join(root, 'cycle-b'), path.join(root, 'cycle-a'))
  await fs.symlink(path.join(root, 'cycle-a'), path.join(root, 'cycle-b'))
})

afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

describe('resolveSafe allows valid paths', () => {
  it('allows an existing file', async () => {
    await expect(resolveSafe(root, 'notes/a.md')).resolves.toBe(path.join(root, 'notes', 'a.md'))
  })

  it('allows a not-yet-existing new file (parent directory exists)', async () => {
    await expect(resolveSafe(root, 'notes/new.md')).resolves.toBe(path.join(root, 'notes', 'new.md'))
  })

  it('allows a deeply nested path that does not yet exist', async () => {
    await expect(resolveSafe(root, 'a/b/c/new.md')).resolves.toBe(path.join(root, 'a/b/c/new.md'))
  })

  it('allows a filename that contains .. but is not a path segment', async () => {
    await expect(resolveSafe(root, 'notes/..hidden.md')).resolves.toBe(
      path.join(root, 'notes', '..hidden.md'),
    )
  })

  it('internal .. segments that cancel out are allowed as long as the result remains inside the root', async () => {
    await expect(resolveSafe(root, 'notes/../notes/a.md')).resolves.toBe(
      path.join(root, 'notes', 'a.md'),
    )
  })
})

describe('resolveSafe rejects escapes', () => {
  const rejected: Array<[string, string]> = [
    ['one level up', '../outside/secret.txt'],
    ['multiple levels up', '../../../../etc/passwd'],
    ['mid-path traversal', 'notes/../../outside/secret.txt'],
    ['absolute path', '/etc/passwd'],
    ['empty path', ''],
    ['bare double-dot', '..'],
    ['trailing double-dot', 'notes/..'],
  ]

  for (const [name, input] of rejected) {
    it(`rejects ${name}: ${JSON.stringify(input)}`, async () => {
      await expect(resolveSafe(root, input)).rejects.toBeInstanceOf(VaultPathError)
    })
  }

  it('rejects a path containing a NUL byte', async () => {
    await expect(resolveSafe(root, 'notes/a\0.md')).rejects.toBeInstanceOf(VaultPathError)
  })

  it('rejects a symlink pointing to a directory outside the root', async () => {
    await expect(resolveSafe(root, 'escape-link/secret.txt')).rejects.toBeInstanceOf(VaultPathError)
  })

  it('rejects a symlink pointing to a file outside the root', async () => {
    await expect(resolveSafe(root, 'secret-link.txt')).rejects.toBeInstanceOf(VaultPathError)
  })
})

describe('resolveSafe does not perform double-decoding', () => {
  it('%2e%2e is treated as a literal filename, not as ..', async () => {
    const resolved = await resolveSafe(root, 'notes/%2e%2e/a.md')
    expect(resolved).toBe(path.join(root, 'notes', '%2e%2e', 'a.md'))
  })

  it('%252e%252e is also treated as a literal', async () => {
    const resolved = await resolveSafe(root, '%252e%252e/x.md')
    expect(resolved).toBe(path.join(root, '%252e%252e', 'x.md'))
  })
})

describe('resolveSafe errors do not leak the server absolute path', () => {
  it('rejects a symlink cycle inside the vault; error message does not contain the vault absolute path', async () => {
    let caught: unknown
    try {
      await resolveSafe(root, 'cycle-a')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(VaultPathError)
    expect((caught as Error).message).not.toContain(root)
  })

  it('a child path under a symlink cycle is also rejected; error message does not contain the vault absolute path', async () => {
    let caught: unknown
    try {
      await resolveSafe(root, 'cycle-a/x.md')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(VaultPathError)
    expect((caught as Error).message).not.toContain(root)
  })

  it('rejects when the vault root itself does not exist; error message does not contain an absolute path', async () => {
    const missingRoot = path.join(base, 'gone')
    let caught: unknown
    try {
      await resolveSafe(missingRoot, 'x.md')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(VaultPathError)
    expect((caught as Error).message).not.toContain(missingRoot)
  })

  // Coverage addition: a symlink immediately followed by a .. that lexically
  // cancels it. path.resolve eliminates 'escape-link/..' lexically before
  // touching the filesystem, so the kernel never follows the symlink; the
  // assertion is the inclusive property “result still inside the vault”, not
  // “must be rejected” — so that if the resolution order is ever changed to a
  // non-lexical approach, this assertion still pins the invariant and prevents
  // it from silently breaking.
  it('symlink followed immediately by a cancelling ..: lexically cancelled result must still be inside the vault root', async () => {
    const resolved = await resolveSafe(root, 'escape-link/../outside/secret.txt')
    expect(resolved.startsWith(root)).toBe(true)
  })
})
