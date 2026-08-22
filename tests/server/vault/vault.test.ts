import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Vault, VaultError } from '../../../src/server/vault/index.js'
import { VaultPathError } from '../../../src/server/vault/paths.js'

let root: string
let vault: Vault

/**
 * Asserts that a rejected operation throws a safe VaultError: the correct
 * type, no absolute vault root path in the message, and the original error
 * preserved in cause for diagnosis. A type-level assertion alone cannot catch
 * "absolute path leaked in message", so the message content is explicitly
 * checked here.
 */
async function expectSafeVaultError(promise: Promise<unknown>): Promise<VaultError> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(VaultError)
  const err = caught as VaultError
  expect(err.message).not.toContain(root)
  expect(err.cause).toBeDefined()
  return err
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-vault-'))
  vault = new Vault(root)
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.writeFile(path.join(root, 'notes', 'a.md'), '# a\n')
  await fs.writeFile(path.join(root, 'readme.md'), 'root note\n')
  await fs.writeFile(path.join(root, 'photo.png'), 'not markdown')
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('tree', () => {
  it('directories first; within each type sorted by name', async () => {
    const entries = await vault.tree()
    expect(entries.map((e) => e.name)).toEqual(['notes', 'photo.png', 'readme.md'])
  })

  it('nested directories include children', async () => {
    const entries = await vault.tree()
    const notes = entries.find((e) => e.name === 'notes')
    expect(notes?.type).toBe('dir')
    expect(notes?.children?.map((c) => c.path)).toEqual(['notes/a.md'])
  })

  it('hides .git and other dot-prefixed entries', async () => {
    const entries = await vault.tree()
    expect(entries.some((e) => e.name.startsWith('.'))).toBe(false)
  })
})

describe('read / write', () => {
  it('reads content and mtime', async () => {
    const file = await vault.read('notes/a.md')
    expect(file.content).toBe('# a\n')
    expect(file.mtimeMs).toBeGreaterThan(0)
  })

  it('mtime advances after a write', async () => {
    const before = await vault.read('notes/a.md')
    await new Promise((r) => setTimeout(r, 10))
    const after = await vault.write('notes/a.md', '# changed\n')
    expect(after.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs)
    expect((await vault.read('notes/a.md')).content).toBe('# changed\n')
  })

  it('automatically creates missing parent directories on write', async () => {
    await vault.write('deep/nested/x.md', 'hi')
    expect((await vault.read('deep/nested/x.md')).content).toBe('hi')
  })

  it('reading a non-existent file throws VaultError not a raw ENOENT', async () => {
    await expect(vault.read('nope.md')).rejects.toBeInstanceOf(VaultError)
  })

  it('reading a directory throws VaultError', async () => {
    await expect(vault.read('notes')).rejects.toBeInstanceOf(VaultError)
  })

  it('traversal paths are rejected on read too', async () => {
    await expect(vault.read('../etc/passwd')).rejects.toBeInstanceOf(VaultPathError)
  })
})

describe('createFile / createDir', () => {
  it('creates an empty file', async () => {
    await vault.createFile('notes/b.md')
    expect((await vault.read('notes/b.md')).content).toBe('')
  })

  it('refuses to create when the path already exists; does not overwrite', async () => {
    await expect(vault.createFile('notes/a.md')).rejects.toBeInstanceOf(VaultError)
    expect((await vault.read('notes/a.md')).content).toBe('# a\n')
  })

  it('creates a directory', async () => {
    await vault.createDir('journal')
    const entries = await vault.tree()
    expect(entries.find((e) => e.name === 'journal')?.type).toBe('dir')
  })
})

describe('rename / remove', () => {
  it('renames a file', async () => {
    await vault.rename('notes/a.md', 'notes/renamed.md')
    await expect(vault.read('notes/a.md')).rejects.toBeInstanceOf(VaultError)
    expect((await vault.read('notes/renamed.md')).content).toBe('# a\n')
  })

  it('refuses to rename when the target already exists', async () => {
    await expect(vault.rename('notes/a.md', 'readme.md')).rejects.toBeInstanceOf(VaultError)
  })

  it('the rename target path is also validated', async () => {
    await expect(vault.rename('notes/a.md', '../escaped.md')).rejects.toBeInstanceOf(VaultPathError)
  })

  it('deletes a file', async () => {
    await vault.remove('notes/a.md')
    await expect(vault.read('notes/a.md')).rejects.toBeInstanceOf(VaultError)
  })

  it('deletes a directory along with its contents', async () => {
    await vault.remove('notes')
    expect((await vault.tree()).some((e) => e.name === 'notes')).toBe(false)
  })

  it('refuses to delete the vault root', async () => {
    await expect(vault.remove('.')).rejects.toBeInstanceOf(VaultPathError)
  })
})

describe('tree, and the pictures', () => {
  it('sends them, because hiding them is the browser\'s job', async () => {
    // They were dropped here once, and a switch in Settings could then never bring them back — a
    // tree that has never sent a folder cannot be asked to show it. What the reader sees is
    // decided in `FileTree.tsx`; what the vault *has* is decided here.
    await vault.writeAsset(Buffer.from('a picture'), 'webp')
    const names = (await vault.tree()).map((e) => e.name)
    expect(names).toContain('assets')
  })

  it('nests them like any other directory', async () => {
    await vault.writeAsset(Buffer.from('another'), 'webp')
    const assets = (await vault.tree()).find((e) => e.name === 'assets')
    expect(assets?.type).toBe('dir')
    expect(assets?.children?.every((c) => c.type === 'file')).toBe(true)
  })
})

describe('writeAsset', () => {
  it('writes to assets/ and returns the relative path', async () => {
    const { path: rel, existed } = await vault.writeAsset(Buffer.from('png-bytes'), 'png')
    expect(rel).toMatch(/^assets\/[a-f0-9]{16}\.png$/)
    expect(existed).toBe(false)
    expect(await fs.readFile(path.join(root, rel), 'utf8')).toBe('png-bytes')
  })

  it('names a picture after its own bytes, so the same one is written once', async () => {
    const a = await vault.writeAsset(Buffer.from('identical'), 'webp')
    const b = await vault.writeAsset(Buffer.from('identical'), 'webp')
    const c = await vault.writeAsset(Buffer.from('different'), 'webp')
    expect(b.path).toBe(a.path)
    expect(c.path).not.toBe(a.path)
  })

  it('says so, and does not write again, when the picture is already here', async () => {
    const { path: rel } = await vault.writeAsset(Buffer.from('twice'), 'webp')
    const before = (await fs.stat(path.join(root, rel))).mtimeMs
    await new Promise((r) => setTimeout(r, 10))

    const second = await vault.writeAsset(Buffer.from('twice'), 'webp')
    expect(second).toEqual({ path: rel, existed: true })
    // Untouched: a rewrite would move the mtime and the watcher would announce a change that
    // never happened.
    expect((await fs.stat(path.join(root, rel))).mtimeMs).toBe(before)
  })

  it('rejects suspicious file extensions', async () => {
    await expect(vault.writeAsset(Buffer.from('x'), '../evil')).rejects.toBeInstanceOf(
      VaultError,
    )
  })
})

describe('errno translation: must not leak absolute paths via raw errors', () => {
  it('write() throws a safe VaultError when the target path is an existing directory', async () => {
    await fs.mkdir(path.join(root, 'adir'))
    await expectSafeVaultError(vault.write('adir', 'y'))
  })

  it('write() throws a safe VaultError when the path passes through an existing file', async () => {
    await expectSafeVaultError(vault.write('readme.md/x.md', 'y'))
  })

  it('createFile() throws a safe VaultError when the path passes through an existing file', async () => {
    await expectSafeVaultError(vault.createFile('readme.md/x.md'))
  })

  it("createDir() message is distinct from 'already exists' when the parent directory does not exist", async () => {
    const err = await expectSafeVaultError(vault.createDir('journal/nested'))
    expect(err.message).not.toMatch(/already exists/i)
  })

  it('tree() still succeeds when a subdirectory is unreadable; that directory is shown as empty', async () => {
    const noreadAbs = path.join(root, 'noread')
    await fs.mkdir(noreadAbs)
    await fs.chmod(noreadAbs, 0o000)
    try {
      const entries = await vault.tree()
      const entry = entries.find((e) => e.name === 'noread')
      expect(entry?.type).toBe('dir')
      expect(entry?.children).toEqual([])
    } finally {
      await fs.chmod(noreadAbs, 0o755)
    }
  })

  it('read() throws a safe VaultError when the file is unreadable (skipped if the current user can bypass permission bits)', async () => {
    const target = path.join(root, 'notes', 'a.md')
    await fs.chmod(target, 0o000)
    try {
      let permissionEnforced = true
      try {
        await fs.readFile(target)
        permissionEnforced = false
      } catch {
        // Permission bits are enforced; proceed with assertions below.
      }
      if (!permissionEnforced) {
        // The current user (e.g. root) bypassed the file permission bits;
        // this scenario cannot be verified, so skip.
        return
      }
      await expectSafeVaultError(vault.read('notes/a.md'))
    } finally {
      await fs.chmod(target, 0o644)
    }
  })
})
