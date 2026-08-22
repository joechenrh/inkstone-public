# Inkstone Phase 0: Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a usable server-hosted markdown editor — log in, browse the file tree, edit plain source, persist automatically, commit to git periodically, and handle conflicts correctly when files change externally.

**Architecture:** A single-process Node/TS service (Fastify) serving a Vite-built Preact frontend. The backend splits into five modules — `config`/`vault`/`git`/`watcher`/`server` — with dependencies pointing one way, toward `server`. All filesystem access goes through `vault` as the single gate, with paths normalized first and then validated via realpath. The frontend uses REST for request/response and a single WebSocket to receive server pushes.

**Tech Stack:** Node 22+、TypeScript 5（strict）、Fastify 5、simple-git、chokidar 4、Vite 6、Preact 10 + @preact/signals、CodeMirror 6、Vitest 3、Playwright。

## Global Constraints

- Package manager `pnpm`, a single package (not a monorepo), sources in `src/server/` and `src/web/`, tests in `tests/`.
- TypeScript `strict: true`, no `any` escapes (`@typescript-eslint/no-explicit-any` is an error).
- **Every** externally supplied path must go through `resolveSafe()`; no module may do its own `path.join(root, userInput)`.
- `LISTEN_ADDR` defaults to `127.0.0.1` and **must not** default to `0.0.0.0`.
- `SESSION_SECRET` must be independent of `AUTH_PASSWORD`; neither may be derived from the other.
- Persisting and git commit are two different things: persisting is a 1s debounce that only writes the file; commit has its own trigger conditions (see Task 8).
- Every task ends with one commit, with a Conventional Commits prefix on the message.
- Tests use Vitest. Backend tests run in the `node` environment and frontend tests in `jsdom`, configured separately via `vitest.workspace.ts`.

---

### Task 1: Project scaffolding and config loading

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.workspace.ts`, `.gitignore`
- Create: `src/server/config.ts`
- Test: `tests/server/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config`；`interface Config { vaultRoot: string; password: string; sessionSecret: string; listenAddr: string; port: number; codexBin: string }`；`class ConfigError extends Error`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "inkstone",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:server": "tsx watch src/server/main.ts",
    "dev:web": "vite",
    "build": "tsc -p tsconfig.server.json && vite build",
    "start": "node dist/server/main.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.2",
    "@fastify/static": "^8.0.4",
    "@fastify/websocket": "^11.0.2",
    "chokidar": "^4.0.3",
    "fastify": "^5.2.1",
    "simple-git": "^3.27.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "jsdom": "^26.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vite": "^6.0.7",
    "vitest": "^3.0.2"
  }
}
```

Frontend dependencies come in Task 9, to avoid installing a pile of things that are not used yet.

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests"]
}
```

Also create `tsconfig.server.json` for the build:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "noEmit": false,
    "lib": ["ES2023"]
  },
  "include": ["src/server"]
}
```

`rootDir` must be `"src"` and not `"."`: the former compiles `src/server/main.ts` to `dist/server/main.js`, which lines up both with Task 13's start command `node dist/server/main.js` and with the static asset path it derives as `dist/web` from `../web`; the latter would add an extra `dist/src/` layer.

- [ ] **Step 3: Create vitest.workspace.ts and .gitignore**

```ts
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'server',
      environment: 'node',
      globals: true,
      include: ['tests/server/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'web',
      environment: 'jsdom',
      globals: true,
      include: ['tests/web/**/*.test.ts'],
    },
  },
])
```

`.gitignore`：

```
node_modules/
dist/
.DS_Store
*.log
test-results/
playwright-report/
```

- [ ] **Step 4: Write the failing config test**

`tests/server/config.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/server/config.js'

const base = {
  VAULT_ROOT: '/tmp/vault',
  AUTH_PASSWORD: 'pw',
  SESSION_SECRET: 'secret',
}

describe('loadConfig', () => {
  it('fills in defaults', () => {
    const cfg = loadConfig(base)
    expect(cfg.listenAddr).toBe('127.0.0.1')
    expect(cfg.port).toBe(7654)
    expect(cfg.codexBin).toBe('codex')
  })

  it('names the specific variable when a required one is missing', () => {
    expect(() => loadConfig({ ...base, VAULT_ROOT: undefined })).toThrow(ConfigError)
    expect(() => loadConfig({ ...base, VAULT_ROOT: undefined })).toThrow(/VAULT_ROOT/)
  })

  it('rejects SESSION_SECRET being identical to AUTH_PASSWORD', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'pw' })).toThrow(/must differ/i)
  })

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/)
  })

  it('normalizes vaultRoot to an absolute path with no trailing slash', () => {
    expect(loadConfig({ ...base, VAULT_ROOT: '/tmp/vault/' }).vaultRoot).toBe('/tmp/vault')
  })
})
```

- [ ] **Step 5: Run the test and confirm it fails**

Run: `pnpm vitest run tests/server/config.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/server/config.js"`

- [ ] **Step 6: Implement config.ts**

```ts
import path from 'node:path'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export interface Config {
  vaultRoot: string
  password: string
  sessionSecret: string
  listenAddr: string
  port: number
  codexBin: string
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new ConfigError(`${key} is required`)
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const vaultRoot = path.resolve(required(env, 'VAULT_ROOT'))
  const password = required(env, 'AUTH_PASSWORD')
  const sessionSecret = required(env, 'SESSION_SECRET')

  if (password === sessionSecret) {
    throw new ConfigError('AUTH_PASSWORD and SESSION_SECRET must differ')
  }

  const portRaw = env.PORT ?? '7654'
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer in 1..65535, got ${portRaw}`)
  }

  return {
    vaultRoot,
    password,
    sessionSecret,
    listenAddr: env.LISTEN_ADDR ?? '127.0.0.1',
    port,
    codexBin: env.CODEX_BIN ?? 'codex',
  }
}
```

- [ ] **Step 7: Run the test and confirm it passes**

Run: `pnpm vitest run tests/server/config.test.ts`
Expected: PASS, all 5 cases green

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json tsconfig.server.json vitest.workspace.ts .gitignore src/server/config.ts tests/server/config.test.ts
git commit -m "feat(config): add typed env config loader with validation"
```

---

### Task 2: The vault path safety gate

This is the whole service's security boundary. A bug in this module is directly equivalent to leaking server files, so it gets its own task, with far more test code than implementation.

**Files:**
- Create: `src/server/vault/paths.ts`
- Test: `tests/server/vault/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `resolveSafe(root: string, relPath: string): Promise<string>` (returns an absolute path); `class VaultPathError extends Error`

- [ ] **Step 1: Write the failing path-traversal tests**

`tests/server/vault/paths.test.ts`：

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveSafe, VaultPathError } from '../../../src/server/vault/paths.js'

let root: string
let outside: string

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-paths-'))
  root = path.join(base, 'vault')
  outside = path.join(base, 'outside')
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(root, 'notes', 'a.md'), '# a')
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret')
  await fs.symlink(outside, path.join(root, 'escape-link'))
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'secret-link.txt'))
})

afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

describe('resolveSafe allows legitimate paths', () => {
  it('allows an existing file', async () => {
    await expect(resolveSafe(root, 'notes/a.md')).resolves.toBe(path.join(root, 'notes', 'a.md'))
  })

  it('allows a new file that does not exist yet (with an existing parent)', async () => {
    await expect(resolveSafe(root, 'notes/new.md')).resolves.toBe(path.join(root, 'notes', 'new.md'))
  })

  it('allows a deep new path that does not exist yet', async () => {
    await expect(resolveSafe(root, 'a/b/c/new.md')).resolves.toBe(path.join(root, 'a/b/c/new.md'))
  })

  it('allows a file whose name contains .. but not as a path segment', async () => {
    await expect(resolveSafe(root, 'notes/..hidden.md')).resolves.toBe(
      path.join(root, 'notes', '..hidden.md'),
    )
  })

  it('an interior .. may cancel out, as long as the result stays inside the root', async () => {
    await expect(resolveSafe(root, 'notes/../notes/a.md')).resolves.toBe(
      path.join(root, 'notes', 'a.md'),
    )
  })
})

describe('resolveSafe rejects escapes', () => {
  const rejected: Array<[string, string]> = [
    ['one level up', '../outside/secret.txt'],
    ['multiple levels up', '../../../../etc/passwd'],
    ['up in the middle', 'notes/../../outside/secret.txt'],
    ['absolute path', '/etc/passwd'],
    ['empty path', ''],
    ['a bare dot-dot', '..'],
    ['trailing up', 'notes/..'],
  ]

  for (const [name, input] of rejected) {
    it(`rejects ${name}: ${JSON.stringify(input)}`, async () => {
      await expect(resolveSafe(root, input)).rejects.toBeInstanceOf(VaultPathError)
    })
  }

  it('rejects a path containing a NUL byte', async () => {
    await expect(resolveSafe(root, 'notes/a\0.md')).rejects.toBeInstanceOf(VaultPathError)
  })

  it('rejects a symlink pointing at a directory outside the root', async () => {
    await expect(resolveSafe(root, 'escape-link/secret.txt')).rejects.toBeInstanceOf(VaultPathError)
  })

  it('rejects a symlink pointing at a file outside the root', async () => {
    await expect(resolveSafe(root, 'secret-link.txt')).rejects.toBeInstanceOf(VaultPathError)
  })
})

describe('resolveSafe does not decode twice', () => {
  it('treats %2e%2e as a literal filename, not as ..', async () => {
    const resolved = await resolveSafe(root, 'notes/%2e%2e/a.md')
    expect(resolved).toBe(path.join(root, 'notes', '%2e%2e', 'a.md'))
  })

  it('%252e%252e is likewise a literal', async () => {
    const resolved = await resolveSafe(root, '%252e%252e/x.md')
    expect(resolved).toBe(path.join(root, '%252e%252e', 'x.md'))
  })
})
```

The two "does not decode twice" cases are deliberate: the HTTP layer has already decoded once, and having `resolveSafe` decode again would manufacture a new traversal surface. What is asserted here is the **not decoding** behaviour itself.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/server/vault/paths.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement paths.ts**

```ts
import fs from 'node:fs/promises'
import path from 'node:path'

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultPathError'
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * realpath the deepest existing ancestor, then append the remaining non-existent part back on.
 * This way a newly created file also gets a canonical path free of symlinks.
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
 * Resolves a user-supplied relative path into an absolute path inside the vault.
 * Rejects every escape: absolute paths, .. traversal, NUL bytes, and symlinks pointing outside the root.
 * Does no URL decoding — the HTTP layer already decoded once, and decoding again here would manufacture a new traversal surface.
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

  const rootReal = await fs.realpath(root)
  const target = path.resolve(rootReal, relPath)

  if (!isInside(rootReal, target)) {
    throw new VaultPathError(`path escapes vault root: ${relPath}`)
  }

  const real = await realpathDeepest(target)
  if (!isInside(rootReal, real)) {
    throw new VaultPathError(`path resolves outside vault root via symlink: ${relPath}`)
  }

  return target
}
```

Note that it returns `target` rather than `real`: what the caller gets should be a path inside the vault, with the symlink used only for validation and never to rewrite the return value.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run tests/server/vault/paths.test.ts`
Expected: PASS, all 17 cases pass

- [ ] **Step 5: Commit**

```bash
git add src/server/vault/paths.ts tests/server/vault/paths.test.ts
git commit -m "feat(vault): add resolveSafe path guard with traversal and symlink tests"
```

---

### Task 3: vault file operations

**Files:**
- Create: `src/server/vault/index.ts`
- Test: `tests/server/vault/vault.test.ts`

**Interfaces:**
- Consumes: `resolveSafe`、`VaultPathError`（Task 2）
- Produces:

```ts
export interface VaultEntry {
  name: string
  path: string          // POSIX relative path inside the vault
  type: 'file' | 'dir'
  children?: VaultEntry[]
}

export interface FileContent {
  content: string
  mtimeMs: number
}

export class Vault {
  constructor(root: string)
  readonly root: string
  tree(): Promise<VaultEntry[]>
  read(relPath: string): Promise<FileContent>
  write(relPath: string, content: string): Promise<{ mtimeMs: number }>
  createFile(relPath: string): Promise<void>
  createDir(relPath: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(relPath: string): Promise<void>
  writeAsset(bytes: Buffer, ext: string, seed: string): Promise<string>
}
export class VaultError extends Error
```

- [ ] **Step 1: Write the failing vault tests**

`tests/server/vault/vault.test.ts`：

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Vault, VaultError } from '../../../src/server/vault/index.js'
import { VaultPathError } from '../../../src/server/vault/paths.js'

let root: string
let vault: Vault

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
  it('directories first, then same-type entries sorted by name', async () => {
    const entries = await vault.tree()
    expect(entries.map((e) => e.name)).toEqual(['notes', 'photo.png', 'readme.md'])
  })

  it('nested directories carry children', async () => {
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
  it('reads back the content and mtime', async () => {
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

  it('creates missing parent directories on write', async () => {
    await vault.write('deep/nested/x.md', 'hi')
    expect((await vault.read('deep/nested/x.md')).content).toBe('hi')
  })

  it('reading a nonexistent file throws VaultError rather than a bare ENOENT', async () => {
    await expect(vault.read('nope.md')).rejects.toBeInstanceOf(VaultError)
  })

  it('reading a directory throws VaultError', async () => {
    await expect(vault.read('notes')).rejects.toBeInstanceOf(VaultError)
  })

  it('a traversal path is rejected on read as well', async () => {
    await expect(vault.read('../etc/passwd')).rejects.toBeInstanceOf(VaultPathError)
  })
})

describe('createFile / createDir', () => {
  it('creates an empty file', async () => {
    await vault.createFile('notes/b.md')
    expect((await vault.read('notes/b.md')).content).toBe('')
  })

  it('refuses to create when it already exists, never overwriting', async () => {
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

  it('the rename target path is validated too', async () => {
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

describe('writeAsset', () => {
  it('writes into assets/ and returns the relative path', async () => {
    const rel = await vault.writeAsset(Buffer.from('png-bytes'), 'png', 'seed-1')
    expect(rel).toMatch(/^assets\/[a-f0-9]{16}\.png$/)
    const abs = path.join(root, rel)
    expect(await fs.readFile(abs, 'utf8')).toBe('png-bytes')
  })

  it('the same seed and content give the same path (idempotent)', async () => {
    const a = await vault.writeAsset(Buffer.from('same'), 'png', 'seed')
    const b = await vault.writeAsset(Buffer.from('same'), 'png', 'seed')
    expect(a).toBe(b)
  })

  it('rejects suspicious extensions', async () => {
    await expect(vault.writeAsset(Buffer.from('x'), '../evil', 'seed')).rejects.toBeInstanceOf(
      VaultError,
    )
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/server/vault/vault.test.ts`
Expected: FAIL, `src/server/vault/index.ts` does not exist

- [ ] **Step 3: Implement vault/index.ts**

```ts
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveSafe, VaultPathError } from './paths.js'

export class VaultError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

export interface VaultEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: VaultEntry[]
}

export interface FileContent {
  content: string
  mtimeMs: number
}

const ASSET_DIR = 'assets'
const SAFE_EXT = /^[a-z0-9]{1,8}$/i

export class Vault {
  constructor(readonly root: string) {}

  async tree(): Promise<VaultEntry[]> {
    return this.#readDir(this.root, '')
  }

  async #readDir(absDir: string, relDir: string): Promise<VaultEntry[]> {
    const dirents = await fs.readdir(absDir, { withFileTypes: true })
    const entries: VaultEntry[] = []

    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name

      if (dirent.isDirectory()) {
        entries.push({
          name: dirent.name,
          path: rel,
          type: 'dir',
          children: await this.#readDir(path.join(absDir, dirent.name), rel),
        })
      } else if (dirent.isFile()) {
        entries.push({ name: dirent.name, path: rel, type: 'file' })
      }
      // symlinks and other types are always skipped: the tree does not show entries that cannot be resolved safely
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
    return { content: await fs.readFile(abs, 'utf8'), mtimeMs: stat.mtimeMs }
  }

  async write(relPath: string, content: string): Promise<{ mtimeMs: number }> {
    const abs = await resolveSafe(this.root, relPath)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
    const stat = await fs.stat(abs)
    return { mtimeMs: stat.mtimeMs }
  }

  async createFile(relPath: string): Promise<void> {
    const abs = await resolveSafe(this.root, relPath)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    try {
      // the wx flag guarantees failure when it already exists, never overwriting
      await fs.writeFile(abs, '', { encoding: 'utf8', flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new VaultError(`already exists: ${relPath}`)
      }
      throw err
    }
  }

  async createDir(relPath: string): Promise<void> {
    const abs = await resolveSafe(this.root, relPath)
    try {
      await fs.mkdir(abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new VaultError(`already exists: ${relPath}`)
      }
      throw err
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const absFrom = await resolveSafe(this.root, from)
    const absTo = await resolveSafe(this.root, to)
    await this.#statOrThrow(absFrom, from)

    if (await this.#exists(absTo)) {
      throw new VaultError(`target already exists: ${to}`)
    }
    await fs.mkdir(path.dirname(absTo), { recursive: true })
    await fs.rename(absFrom, absTo)
  }

  async remove(relPath: string): Promise<void> {
    const abs = await resolveSafe(this.root, relPath)
    await this.#statOrThrow(abs, relPath)
    await fs.rm(abs, { recursive: true, force: false })
  }

  async writeAsset(bytes: Buffer, ext: string, seed: string): Promise<string> {
    if (!SAFE_EXT.test(ext)) {
      throw new VaultError(`unsafe asset extension: ${ext}`)
    }
    const digest = createHash('sha256')
      .update(seed)
      .update(bytes)
      .digest('hex')
      .slice(0, 16)
    const rel = `${ASSET_DIR}/${digest}.${ext.toLowerCase()}`
    const abs = await resolveSafe(this.root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, bytes)
    return rel
  }

  async #statOrThrow(abs: string, relPath: string) {
    try {
      return await fs.stat(abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VaultError(`not found: ${relPath}`)
      }
      throw err
    }
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
```

`remove('.')` is caught by `resolveSafe` — `path.relative(root, root)` is the empty string, so `isInside` returns false. This is exactly why `isInside` in Task 2 requires `rel !== ''`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run tests/server/vault/`
Expected: PASS, the Task 2 and Task 3 cases all green

- [ ] **Step 5: Commit**

```bash
git add src/server/vault/index.ts tests/server/vault/vault.test.ts
git commit -m "feat(vault): add file CRUD, tree listing, and asset writer"
```

---

### Task 4: The git module

**Files:**
- Create: `src/server/git/index.ts`
- Test: `tests/server/git/git.test.ts`

**Interfaces:**
- Consumes: nothing (only takes the root path string)
- Produces:

```ts
export interface GitStatus { dirty: boolean; branch: string }
export interface CommitResult { sha: string; files: string[] }

export class VaultGit {
  constructor(root: string)
  isRepo(): Promise<boolean>
  status(): Promise<GitStatus>
  commitAll(message: string): Promise<CommitResult | null>  // returns null when there are no changes
  diffOfCommit(sha: string): Promise<string>
  revertCommit(sha: string): Promise<void>
}
```

`diffOfCommit` and `revertCommit` are not used by any route in Phase 0, but implementing and testing them now means Phase 2's codex turn rollback can consume them directly — avoiding a return trip to this module then.

- [ ] **Step 1: Write the failing git tests**

`tests/server/git/git.test.ts`：

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'
import { VaultGit } from '../../../src/server/git/index.js'

let root: string
let git: VaultGit

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-git-'))
  const raw = simpleGit(root)
  await raw.init(['--initial-branch=main'])
  await raw.addConfig('user.email', 'test@example.com')
  await raw.addConfig('user.name', 'Test')
  await fs.writeFile(path.join(root, 'a.md'), 'one\n')
  await raw.add('.')
  await raw.commit('initial')
  git = new VaultGit(root)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('isRepo', () => {
  it('returns true for a git repository', async () => {
    expect(await git.isRepo()).toBe(true)
  })

  it('returns false for a non-repository directory', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-plain-'))
    expect(await new VaultGit(plain).isRepo()).toBe(false)
    await fs.rm(plain, { recursive: true, force: true })
  })
})

describe('status', () => {
  it('dirty is false when clean, and the branch name is present', async () => {
    const s = await git.status()
    expect(s.dirty).toBe(false)
    expect(s.branch).toBe('main')
  })

  it('dirty is true when there is an untracked file', async () => {
    await fs.writeFile(path.join(root, 'b.md'), 'two\n')
    expect((await git.status()).dirty).toBe(true)
  })

  it('dirty is true when there is a modified file', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'changed\n')
    expect((await git.status()).dirty).toBe(true)
  })
})

describe('commitAll', () => {
  it('commits all changes and returns the sha and file list', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'changed\n')
    await fs.writeFile(path.join(root, 'b.md'), 'two\n')
    const result = await git.commitAll('test: change two files')
    expect(result).not.toBeNull()
    expect(result!.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(result!.files.sort()).toEqual(['a.md', 'b.md'])
    expect((await git.status()).dirty).toBe(false)
  })

  it('returns null and produces no empty commit when there are no changes', async () => {
    const before = await simpleGit(root).log()
    expect(await git.commitAll('noop')).toBeNull()
    const after = await simpleGit(root).log()
    expect(after.total).toBe(before.total)
  })

  it('commits deleted files', async () => {
    await fs.rm(path.join(root, 'a.md'))
    const result = await git.commitAll('test: delete')
    expect(result!.files).toEqual(['a.md'])
  })
})

describe('diffOfCommit / revertCommit', () => {
  it('the diff contains the changed content', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'changed\n')
    const result = await git.commitAll('test: change')
    const diff = await git.diffOfCommit(result!.sha)
    expect(diff).toContain('-one')
    expect(diff).toContain('+changed')
  })

  it('revert undoes that commit\'s content', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'changed\n')
    const result = await git.commitAll('test: change')
    await git.revertCommit(result!.sha)
    expect(await fs.readFile(path.join(root, 'a.md'), 'utf8')).toBe('one\n')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/server/git/git.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement git/index.ts**

```ts
import { simpleGit, type SimpleGit } from 'simple-git'

export interface GitStatus {
  dirty: boolean
  branch: string
}

export interface CommitResult {
  sha: string
  files: string[]
}

export class VaultGit {
  readonly #git: SimpleGit

  constructor(readonly root: string) {
    this.#git = simpleGit(root)
  }

  async isRepo(): Promise<boolean> {
    try {
      return await this.#git.checkIsRepo()
    } catch {
      return false
    }
  }

  async status(): Promise<GitStatus> {
    const s = await this.#git.status()
    return { dirty: !s.isClean(), branch: s.current ?? 'HEAD' }
  }

  async commitAll(message: string): Promise<CommitResult | null> {
    await this.#git.add(['-A'])
    const staged = await this.#git.status()
    if (staged.staged.length === 0 && staged.renamed.length === 0) return null

    const files = [
      ...staged.staged,
      ...staged.renamed.map((r) => r.to),
    ].sort()

    const commit = await this.#git.commit(message)
    const sha = await this.#git.revparse(['HEAD'])
    void commit
    return { sha, files }
  }

  async diffOfCommit(sha: string): Promise<string> {
    return this.#git.diff([`${sha}^`, sha])
  }

  async revertCommit(sha: string): Promise<void> {
    await this.#git.raw(['revert', '--no-edit', sha])
  }
}
```

`commitAll` runs `add -A` before looking at `staged`, because simple-git's `status().staged` only counts files already in the index — untracked files do not appear there until `add`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run tests/server/git/git.test.ts`
Expected: PASS, all 10 cases green

- [ ] **Step 5: Commit**

```bash
git add src/server/git/index.ts tests/server/git/git.test.ts
git commit -m "feat(git): add vault git wrapper with commit, diff, and revert"
```

---

### Task 5: The Fastify app and authentication

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/auth.ts`
- Test: `tests/server/auth.test.ts`
- Test helper: `tests/server/helpers/app.ts`

**Interfaces:**
- Consumes: `Config`（Task 1）、`Vault`（Task 3）、`VaultGit`（Task 4）
- Produces:

```ts
// src/server/auth.ts
export const SESSION_COOKIE = 'inkstone_sid'
export function registerAuth(app: FastifyInstance, cfg: Config): void

// src/server/app.ts
export interface AppDeps { config: Config; vault: Vault; git: VaultGit }
export function buildApp(deps: AppDeps): FastifyInstance
```

`buildApp` only assembles; it does not listen. `main.ts` (Task 13) is responsible for `listen`. This way every route test can run through `app.inject()` without occupying a port.

- [ ] **Step 1: Write the test helper**

`tests/server/helpers/app.ts`：

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { buildApp } from '../../../src/server/app.js'
import type { Config } from '../../../src/server/config.js'
import { VaultGit } from '../../../src/server/git/index.js'
import { Vault } from '../../../src/server/vault/index.js'

export interface TestApp {
  app: ReturnType<typeof buildApp>
  root: string
  config: Config
  cleanup: () => Promise<void>
}

export async function makeTestApp(): Promise<TestApp> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-app-'))
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.writeFile(path.join(root, 'notes', 'a.md'), '# a\n')

  const raw = simpleGit(root)
  await raw.init(['--initial-branch=main'])
  await raw.addConfig('user.email', 'test@example.com')
  await raw.addConfig('user.name', 'Test')
  await raw.add('.')
  await raw.commit('initial')

  const config: Config = {
    vaultRoot: root,
    password: 'correct-horse',
    sessionSecret: 'a-different-secret',
    listenAddr: '127.0.0.1',
    port: 0,
    codexBin: 'codex',
  }

  const app = buildApp({ config, vault: new Vault(root), git: new VaultGit(root) })
  await app.ready()

  return {
    app,
    root,
    config,
    cleanup: async () => {
      await app.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/** Logs in and returns a cookie header that can be dropped straight into subsequent requests. */
export async function login(t: TestApp): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: t.config.password },
  })
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!raw) throw new Error('login did not set a cookie')
  return raw.split(';')[0]!
}
```

- [ ] **Step 2: Write the failing auth tests**

`tests/server/auth.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { login, makeTestApp, type TestApp } from './helpers/app.js'

let t: TestApp

beforeEach(async () => {
  t = await makeTestApp()
})

afterEach(async () => {
  await t.cleanup()
})

describe('POST /api/login', () => {
  it('issues an HttpOnly signed cookie when the password is correct', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'correct-horse' },
    })
    expect(res.statusCode).toBe(204)
    const cookie = res.headers['set-cookie']
    const raw = Array.isArray(cookie) ? cookie[0] : cookie
    expect(raw).toContain('inkstone_sid=')
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('SameSite=Lax')
  })

  it('returns 401 and issues no cookie when the password is wrong', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('returns 400 when the password field is missing', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/login', payload: {} })
    expect(res.statusCode).toBe(400)
  })
})

describe('the auth guard', () => {
  it('returns 401 for /api/* without a cookie', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/tree' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 for a forged unsigned cookie', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/tree',
      headers: { cookie: 'inkstone_sid=1' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 for a cookie signed with a different key', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/tree',
      headers: { cookie: 'inkstone_sid=1.YWJjZGVm' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('a valid cookie grants access', async () => {
    const cookie = await login(t)
    const res = await t.app.inject({ method: 'GET', url: '/api/tree', headers: { cookie } })
    expect(res.statusCode).toBe(200)
  })

  it('/api/login and /api/health need no authentication', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
  })
})

describe('POST /api/logout', () => {
  it('the old cookie stops working after it is cleared', async () => {
    const cookie = await login(t)
    const out = await t.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })
    expect(out.statusCode).toBe(204)
    const raw = out.headers['set-cookie']
    const str = Array.isArray(raw) ? raw[0] : raw
    expect(str).toContain('inkstone_sid=;')
  })
})
```

Note that the last logout case only asserts the browser side is cleared. The server keeps no session table, so a leaked cookie stays valid until it expires — an accepted trade-off given the "single user, never on the public internet" premise; rotating the key (`SESSION_SECRET`) is the real revocation mechanism.

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm vitest run tests/server/auth.test.ts`
Expected: FAIL, `src/server/app.ts` does not exist

- [ ] **Step 4: Implement auth.ts**

```ts
import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from './config.js'

export const SESSION_COOKIE = 'inkstone_sid'
const SESSION_VALUE = '1'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/** API paths not protected by authentication. Frontend static assets are exempted separately (see app.ts). */
const PUBLIC_API = new Set(['/api/login', '/api/health'])

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function isAuthenticated(req: FastifyRequest): boolean {
  const raw = req.cookies[SESSION_COOKIE]
  if (!raw) return false
  const unsigned = req.unsignCookie(raw)
  return unsigned.valid && unsigned.value === SESSION_VALUE
}

export function registerAuth(app: FastifyInstance, cfg: Config): void {
  app.decorate('isAuthenticated', isAuthenticated)

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    const pathOnly = req.url.split('?')[0] ?? req.url
    if (PUBLIC_API.has(pathOnly)) return
    if (isAuthenticated(req)) return
    return reply.code(401).send({ error: 'unauthorized' })
  })

  app.post<{ Body: { password?: unknown } }>('/api/login', async (req, reply) => {
    const password = req.body?.password
    if (typeof password !== 'string' || password.length === 0) {
      return reply.code(400).send({ error: 'password is required' })
    }
    if (!constantTimeEquals(password, cfg.password)) {
      return reply.code(401).send({ error: 'invalid password' })
    }
    return reply
      .setCookie(SESSION_COOKIE, SESSION_VALUE, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        signed: true,
        maxAge: MAX_AGE_SECONDS,
      })
      .code(204)
      .send()
  })

  app.post('/api/logout', async (_req, reply) => {
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send()
  })

  app.get('/api/health', async () => ({ ok: true }))
}

declare module 'fastify' {
  interface FastifyInstance {
    isAuthenticated(req: FastifyRequest): boolean
  }
}
```

- [ ] **Step 5: Implement the app.ts skeleton**

For now it only installs the cookie plugin and authentication; routes come in Task 6.

```ts
import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuth } from './auth.js'
import type { Config } from './config.js'
import type { VaultGit } from './git/index.js'
import type { Vault } from './vault/index.js'

export interface AppDeps {
  config: Config
  vault: Vault
  git: VaultGit
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false })

  app.register(cookie, { secret: deps.config.sessionSecret })
  registerAuth(app, deps.config)

  return app
}
```

`@fastify/cookie`'s `secret` is used both to issue `signed: true` cookies and to validate them via `unsignCookie`, so a cookie signed with a different key comes back `valid: false`.

**`registerAuth` must attach to the top-level `app`, and must not be wrapped in `app.register(async (instance) => {...})`.** Fastify encapsulates hooks: an `onRequest` installed on a nested instance only protects routes registered inside that same closure. Measured evidence — after moving the guard into a nested plugin:

```
401 guarded    /api/tree              (a route inside the nested closure)
200 UNGUARDED  /api/sibling-plugin    (registered by another app.register)
200 UNGUARDED  /api/direct            (attached directly to app)
```

Later tasks only have to register the file routes the idiomatic Fastify way — one plugin per feature — and the entire read/write API ships undefended, with no existing test noticing. Likewise, when `app.decorate('isAuthenticated', ...)` is installed on a nested instance it is unreachable on the object `buildApp` returns (`typeof === 'undefined'`), while `declare module 'fastify'` is a global augmentation so TypeScript still compiles — and Task 7's WebSocket authentication crashes at runtime.

- [ ] **Step 6: Add a placeholder /api/tree so the auth tests can run**

The auth tests use `/api/tree` as the sample protected route. Add a minimal implementation in `buildApp` for now (Task 6 replaces it with the full version):

```ts
    instance.get('/api/tree', async () => deps.vault.tree())
```

Place it after `registerAuth(instance, deps.config)`.

- [ ] **Step 7: Run the test and confirm it passes**

Run: `pnpm vitest run tests/server/auth.test.ts`
Expected: PASS, all 9 cases green

- [ ] **Step 8: Commit**

```bash
git add src/server/app.ts src/server/auth.ts tests/server/auth.test.ts tests/server/helpers/app.ts
git commit -m "feat(auth): add signed-cookie session guard and login routes"
```

---

### Task 6: File REST routes

**Files:**
- Create: `src/server/routes/files.ts`
- Modify: `src/server/app.ts` (register the routes, removing Task 5's placeholder `/api/tree`)
- Test: `tests/server/routes/files.test.ts`

**Interfaces:**
- Consumes: `Vault`、`VaultGit`、`AppDeps`
- Produces: `registerFileRoutes(app: FastifyInstance, deps: AppDeps): void`

The route contract:

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/tree` | — | `VaultEntry[]` |
| GET | `/api/file?path=<rel>` | — | `{ path, content, mtimeMs }` |
| PUT | `/api/file` | `{ path, content, baseMtimeMs? }` | `{ mtimeMs }` or 409 |
| POST | `/api/file` | `{ path, kind: 'file' \| 'dir' }` | 201 |
| POST | `/api/file/rename` | `{ from, to }` | 204 |
| DELETE | `/api/file` | `{ path }` | 204 |
| GET | `/api/git/status` | — | `{ dirty, branch }` |

`baseMtimeMs` is an optimistic lock: the client sends back the mtime from when it opened the file, and if the mtime on disk has changed (codex or an external editor touched it) the server returns 409 with the current disk state, and the frontend raises the conflict bar.

- [ ] **Step 1: Write the failing route tests**

`tests/server/routes/files.test.ts`：

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { login, makeTestApp, type TestApp } from '../helpers/app.js'

let t: TestApp
let cookie: string

beforeEach(async () => {
  t = await makeTestApp()
  cookie = await login(t)
})

afterEach(async () => {
  await t.cleanup()
})

const auth = () => ({ cookie })

describe('GET /api/tree', () => {
  it('returns an entry tree with directories first', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/tree', headers: auth() })
    expect(res.statusCode).toBe(200)
    const tree = res.json()
    expect(tree[0].name).toBe('notes')
    expect(tree[0].children[0].path).toBe('notes/a.md')
  })
})

describe('GET /api/file', () => {
  it('returns the content and mtime', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/file?path=notes%2Fa.md',
      headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().content).toBe('# a\n')
    expect(res.json().mtimeMs).toBeGreaterThan(0)
  })

  it('returns 404 for a nonexistent file', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/file?path=nope.md', headers: auth() })
    expect(res.statusCode).toBe(404)
  })

  it('returns 400 rather than 404 for a traversal path, leaking no filesystem information', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/file?path=..%2F..%2Fetc%2Fpasswd',
      headers: auth(),
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain('/etc')
  })

  it('returns 400 when the path parameter is missing', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/file', headers: auth() })
    expect(res.statusCode).toBe(400)
  })
})

describe('PUT /api/file', () => {
  it('writes and returns the new mtime', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md', content: '# changed\n' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().mtimeMs).toBeGreaterThan(0)
    expect(await fs.readFile(path.join(t.root, 'notes/a.md'), 'utf8')).toBe('# changed\n')
  })

  it('writes normally when baseMtimeMs matches the disk', async () => {
    const read = await t.app.inject({
      method: 'GET',
      url: '/api/file?path=notes%2Fa.md',
      headers: auth(),
    })
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md', content: 'ok\n', baseMtimeMs: read.json().mtimeMs },
    })
    expect(res.statusCode).toBe(200)
  })

  it('returns 409 with the current disk state when baseMtimeMs is stale', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md', content: 'mine\n', baseMtimeMs: 1 },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().disk.content).toBe('# a\n')
    expect(await fs.readFile(path.join(t.root, 'notes/a.md'), 'utf8')).toBe('# a\n')
  })

  it('returns 400 when content is not a string', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md', content: 42 },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/file', () => {
  it('returns 201 when creating a file', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/b.md', kind: 'file' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('returns 201 when creating a directory', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'journal', kind: 'dir' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('returns 409 when it already exists', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md', kind: 'file' },
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('POST /api/file/rename', () => {
  it('returns 204 on rename', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file/rename',
      headers: auth(),
      payload: { from: 'notes/a.md', to: 'notes/b.md' },
    })
    expect(res.statusCode).toBe(204)
  })

  it('returns 409 when the target already exists', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/b.md', kind: 'file' },
    })
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/file/rename',
      headers: auth(),
      payload: { from: 'notes/a.md', to: 'notes/b.md' },
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('DELETE /api/file', () => {
  it('returns 204 on delete', async () => {
    const res = await t.app.inject({
      method: 'DELETE',
      url: '/api/file',
      headers: auth(),
      payload: { path: 'notes/a.md' },
    })
    expect(res.statusCode).toBe(204)
  })
})

describe('GET /api/git/status', () => {
  it('returns dirty and the branch', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/git/status', headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ dirty: false, branch: 'main' })
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/server/routes/files.test.ts`
Expected: FAIL, `registerFileRoutes` does not exist

- [ ] **Step 3: Implement routes/files.ts**

```ts
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AppDeps } from '../app.js'
import { VaultError } from '../vault/index.js'
import { VaultPathError } from '../vault/paths.js'

interface WriteBody {
  path?: unknown
  content?: unknown
  baseMtimeMs?: unknown
}

interface CreateBody {
  path?: unknown
  kind?: unknown
}

interface RenameBody {
  from?: unknown
  to?: unknown
}

interface DeleteBody {
  path?: unknown
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message })
}

/**
 * Translates vault-layer exceptions into HTTP status codes.
 * Path errors are always 400, and echo back only the path the caller supplied, never the resolved absolute path.
 */
function sendVaultError(reply: FastifyReply, err: unknown) {
  if (err instanceof VaultPathError) {
    return reply.code(400).send({ error: 'invalid path' })
  }
  if (err instanceof VaultError) {
    if (err.message.startsWith('not found')) return reply.code(404).send({ error: 'not found' })
    if (err.message.includes('already exists')) {
      return reply.code(409).send({ error: 'already exists' })
    }
    return reply.code(400).send({ error: err.message })
  }
  throw err
}

export function registerFileRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { vault, git } = deps

  app.get('/api/tree', async () => vault.tree())

  app.get<{ Querystring: { path?: string } }>('/api/file', async (req, reply) => {
    const relPath = req.query.path
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return badRequest(reply, 'path query parameter is required')
    }
    try {
      const file = await vault.read(relPath)
      return { path: relPath, ...file }
    } catch (err) {
      return sendVaultError(reply, err)
    }
  })

  app.put<{ Body: WriteBody }>('/api/file', async (req, reply) => {
    const { path: relPath, content, baseMtimeMs } = req.body ?? {}
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return badRequest(reply, 'path is required')
    }
    if (typeof content !== 'string') {
      return badRequest(reply, 'content must be a string')
    }
    if (baseMtimeMs !== undefined && typeof baseMtimeMs !== 'number') {
      return badRequest(reply, 'baseMtimeMs must be a number')
    }

    try {
      if (typeof baseMtimeMs === 'number') {
        const disk = await vault.read(relPath).catch((err) => {
          if (err instanceof VaultError) return null
          throw err
        })
        // tolerate 1ms of jitter: some filesystems have limited mtime precision
        if (disk && Math.abs(disk.mtimeMs - baseMtimeMs) > 1) {
          return reply.code(409).send({
            error: 'file changed on disk',
            disk: { content: disk.content, mtimeMs: disk.mtimeMs },
          })
        }
      }
      return await vault.write(relPath, content)
    } catch (err) {
      return sendVaultError(reply, err)
    }
  })

  app.post<{ Body: CreateBody }>('/api/file', async (req, reply) => {
    const { path: relPath, kind } = req.body ?? {}
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return badRequest(reply, 'path is required')
    }
    if (kind !== 'file' && kind !== 'dir') {
      return badRequest(reply, "kind must be 'file' or 'dir'")
    }
    try {
      if (kind === 'file') await vault.createFile(relPath)
      else await vault.createDir(relPath)
      return reply.code(201).send()
    } catch (err) {
      return sendVaultError(reply, err)
    }
  })

  app.post<{ Body: RenameBody }>('/api/file/rename', async (req, reply) => {
    const { from, to } = req.body ?? {}
    if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) {
      return badRequest(reply, 'from and to are required')
    }
    try {
      await vault.rename(from, to)
      return reply.code(204).send()
    } catch (err) {
      return sendVaultError(reply, err)
    }
  })

  app.delete<{ Body: DeleteBody }>('/api/file', async (req, reply) => {
    const relPath = req.body?.path
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return badRequest(reply, 'path is required')
    }
    try {
      await vault.remove(relPath)
      return reply.code(204).send()
    } catch (err) {
      return sendVaultError(reply, err)
    }
  })

  app.get('/api/git/status', async () => git.status())
}
```

- [ ] **Step 4: Register in app.ts and delete the placeholder route**

Delete the placeholder `app.get('/api/tree', ...)` line added in Task 5 and replace it with:

```ts
import { registerFileRoutes } from './routes/files.js'
// ...
  registerAuth(app, deps.config)
  registerFileRoutes(app, deps)
```

Both attach directly to the top-level `app`. The reason is in Task 5: an `onRequest` guard installed inside a nested `app.register()` only covers routes in that closure, and the file routes would ship undefended.

- [ ] **Step 4b: Add a global error fallback (required, not optional)**

Fastify's default error handler writes an exception's `.message` verbatim into the 500 response body. Measured:

```
GET /boom -> 500 {"statusCode":500,"error":"Internal Server Error",
                  "message":"ENOENT: no such file, open '/Users/secret/vault/private.md'"}
```

The "error messages contain no absolute server paths" invariant established by the earlier tasks currently rests on each module wrapping things conscientiously, with no structural fallback — any single unwrapped throw downstream puts a server path on the wire. This task adds a large number of routes and request validations, which is exactly where such a gap shows up first, so the fallback lands here.

Add to `buildApp`:

```ts
  app.setErrorHandler((err, req, reply) => {
    // the three known error classes carry deliberately constructed messages containing only the caller's own input, and can be returned verbatim
    if (err instanceof VaultPathError) return reply.code(400).send({ error: 'invalid path' })
    if (err instanceof VaultError) return reply.code(400).send({ error: err.message })
    if (err instanceof VaultGitError) return reply.code(500).send({ error: err.message })
    // Fastify's own 4xx (e.g. a JSON parse failure) keeps its status code, but the details are not echoed
    const status = err.statusCode ?? 500
    if (status >= 400 && status < 500) return reply.code(status).send({ error: 'bad request' })
    // everything else is sanitized, with the original error going only to the log
    req.log.error({ err }, 'unhandled route error')
    return reply.code(500).send({ error: 'internal error' })
  })
```

The key point is that **the original error must still reach the log**; the sanitization applies only to the response body sent to the client — otherwise there is nothing to debug with.

Test: register a route that deliberately throws an exception containing an absolute path, and assert the response body does not contain that path and the status code is 500; assert a `VaultError` still yields 400 with its original message.

- [ ] **Step 5: Run all backend tests and confirm they pass**

Run: `pnpm vitest run --project server`
Expected: PASS, the Task 1–6 cases all green

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/files.ts src/server/app.ts tests/server/routes/files.test.ts
git commit -m "feat(routes): add file CRUD REST API with optimistic mtime locking"
```

---

### Task 7: The watcher and WebSocket push

**Files:**
- Create: `src/server/watcher.ts`
- Create: `src/server/ws.ts`
- Create: `src/shared/events.ts` (event types shared by frontend and backend)
- Modify: `src/server/app.ts`
- Modify: `src/server/routes/files.ts` (mark self-writes after writing)
- Test: `tests/server/watcher.test.ts`

**Interfaces:**
- Consumes: `Vault`、`AppDeps`
- Produces:

```ts
// src/shared/events.ts
export type ServerEvent =
  | { type: 'file-changed'; path: string; mtimeMs: number }
  | { type: 'file-removed'; path: string }
  | { type: 'tree-changed' }
  | { type: 'git-status'; dirty: boolean; branch: string }

// src/server/watcher.ts
export interface WatcherOptions {
  root: string
  onEvent: (event: ServerEvent) => void
  debounceMs?: number   // default 150
  selfWriteWindowMs?: number  // default 1500
}
export class VaultWatcher {
  constructor(opts: WatcherOptions)
  start(): Promise<void>
  stop(): Promise<void>
  /** Called before the server writes a file itself, to suppress the watcher event that follows */
  markSelfWrite(relPath: string): void
}

// src/server/ws.ts
export class WsHub {
  registerRoute(app: FastifyInstance): void
  broadcast(event: ServerEvent): void
  get clientCount(): number
}
```

**How the self-triggering loop is prevented**: `markSelfWrite(rel)` records the path in a Map with a timestamp. When the watcher receives an event for that path, it discards it and clears the record if the timestamp is within `selfWriteWindowMs`. A time window is used rather than "clear after one consumption" because a single `writeFile` triggers multiple fs events on some platforms.

- [ ] **Step 1: Write the failing watcher tests**

`tests/server/watcher.test.ts`：

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerEvent } from '../../src/shared/events.js'
import { VaultWatcher } from '../../src/server/watcher.js'

let root: string
let watcher: VaultWatcher
let events: ServerEvent[]

/** Polling wait — steadier than a fixed sleep, and it does not waste time on a fast machine. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('timed out waiting for condition')
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-watch-'))
  await fs.writeFile(path.join(root, 'a.md'), 'one\n')
  events = []
  watcher = new VaultWatcher({
    root,
    onEvent: (e) => events.push(e),
    debounceMs: 30,
    selfWriteWindowMs: 1000,
  })
  await watcher.start()
})

afterEach(async () => {
  await watcher.stop()
  await fs.rm(root, { recursive: true, force: true })
})

describe('VaultWatcher', () => {
  it('emits file-changed when a file is modified externally', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    await waitFor(() => events.some((e) => e.type === 'file-changed'))
    const evt = events.find((e) => e.type === 'file-changed')
    expect(evt).toMatchObject({ type: 'file-changed', path: 'a.md' })
  })

  it('emits file-removed and tree-changed when a file is deleted', async () => {
    await fs.rm(path.join(root, 'a.md'))
    await waitFor(() => events.some((e) => e.type === 'file-removed'))
    expect(events.map((e) => e.type)).toContain('tree-changed')
  })

  it('emits tree-changed when a file is added', async () => {
    await fs.writeFile(path.join(root, 'b.md'), 'new\n')
    await waitFor(() => events.some((e) => e.type === 'tree-changed'))
  })

  it('markSelfWrite suppresses the event from our own write', async () => {
    watcher.markSelfWrite('a.md')
    await fs.writeFile(path.join(root, 'a.md'), 'self\n')
    await new Promise((r) => setTimeout(r, 300))
    expect(events.filter((e) => e.type === 'file-changed')).toHaveLength(0)
  })

  it('stops suppressing once the window expires', async () => {
    const shortWatcher = new VaultWatcher({
      root,
      onEvent: (e) => events.push(e),
      debounceMs: 30,
      selfWriteWindowMs: 50,
    })
    await shortWatcher.start()
    shortWatcher.markSelfWrite('a.md')
    await new Promise((r) => setTimeout(r, 120))
    await fs.writeFile(path.join(root, 'a.md'), 'later\n')
    await waitFor(() => events.some((e) => e.type === 'file-changed'))
    await shortWatcher.stop()
  })

  it('ignores dot-prefixed paths', async () => {
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref\n')
    await new Promise((r) => setTimeout(r, 300))
    expect(events).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/server/watcher.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement src/shared/events.ts**

```ts
export type ServerEvent =
  | { type: 'file-changed'; path: string; mtimeMs: number }
  | { type: 'file-removed'; path: string }
  | { type: 'tree-changed' }
  | { type: 'git-status'; dirty: boolean; branch: string }
```

- [ ] **Step 4: Implement watcher.ts**

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { ServerEvent } from '../shared/events.js'

export interface WatcherOptions {
  root: string
  onEvent: (event: ServerEvent) => void
  debounceMs?: number
  selfWriteWindowMs?: number
}

export class VaultWatcher {
  #watcher: FSWatcher | null = null
  readonly #selfWrites = new Map<string, number>()
  readonly #pending = new Map<string, NodeJS.Timeout>()
  readonly #root: string
  readonly #onEvent: (event: ServerEvent) => void
  readonly #debounceMs: number
  readonly #selfWriteWindowMs: number

  constructor(opts: WatcherOptions) {
    this.#root = opts.root
    this.#onEvent = opts.onEvent
    this.#debounceMs = opts.debounceMs ?? 150
    this.#selfWriteWindowMs = opts.selfWriteWindowMs ?? 1500
  }

  async start(): Promise<void> {
    this.#watcher = chokidar.watch(this.#root, {
      ignoreInitial: true,
      // ignore any path with a dot-prefixed segment: .git, .obsidian, .DS_Store, and so on
      ignored: (p) => path.relative(this.#root, p).split(path.sep).some((s) => s.startsWith('.')),
      awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 },
    })

    this.#watcher
      .on('add', (abs) => this.#schedule(abs, 'add'))
      .on('change', (abs) => this.#schedule(abs, 'change'))
      .on('unlink', (abs) => this.#schedule(abs, 'unlink'))
      .on('addDir', (abs) => this.#schedule(abs, 'add'))
      .on('unlinkDir', (abs) => this.#schedule(abs, 'unlink'))

    await new Promise<void>((resolve) => {
      this.#watcher!.once('ready', () => resolve())
    })
  }

  async stop(): Promise<void> {
    for (const timer of this.#pending.values()) clearTimeout(timer)
    this.#pending.clear()
    await this.#watcher?.close()
    this.#watcher = null
  }

  markSelfWrite(relPath: string): void {
    this.#selfWrites.set(this.#normalize(relPath), Date.now())
  }

  #normalize(relPath: string): string {
    return relPath.split(path.sep).join('/')
  }

  #isSelfWrite(rel: string): boolean {
    const at = this.#selfWrites.get(rel)
    if (at === undefined) return false
    if (Date.now() - at > this.#selfWriteWindowMs) {
      this.#selfWrites.delete(rel)
      return false
    }
    return true
  }

  #schedule(abs: string, kind: 'add' | 'change' | 'unlink'): void {
    const rel = this.#normalize(path.relative(this.#root, abs))
    if (!rel || rel.startsWith('..')) return

    const key = `${kind}:${rel}`
    const existing = this.#pending.get(key)
    if (existing) clearTimeout(existing)

    this.#pending.set(
      key,
      setTimeout(() => {
        this.#pending.delete(key)
        void this.#emit(rel, kind)
      }, this.#debounceMs),
    )
  }

  async #emit(rel: string, kind: 'add' | 'change' | 'unlink'): Promise<void> {
    if (this.#isSelfWrite(rel)) return

    if (kind === 'unlink') {
      this.#onEvent({ type: 'file-removed', path: rel })
      this.#onEvent({ type: 'tree-changed' })
      return
    }

    if (kind === 'add') {
      this.#onEvent({ type: 'tree-changed' })
    }

    try {
      const stat = await fs.stat(path.join(this.#root, rel))
      if (stat.isFile()) {
        this.#onEvent({ type: 'file-changed', path: rel, mtimeMs: stat.mtimeMs })
      }
    } catch {
      // the file was deleted between the event arriving and the stat; ignore — the unlink event will follow
    }
  }
}
```

- [ ] **Step 5: Run the watcher test and confirm it passes**

Run: `pnpm vitest run tests/server/watcher.test.ts`
Expected: PASS, all 6 cases green

- [ ] **Step 6: Implement ws.ts**

```ts
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { ServerEvent } from '../shared/events.js'

export class WsHub {
  readonly #clients = new Set<WebSocket>()

  get clientCount(): number {
    return this.#clients.size
  }

  registerRoute(app: FastifyInstance): void {
    app.get('/ws', { websocket: true }, (socket, req) => {
      // the WebSocket upgrade request does not go through onRequest's /api/ guard, so it must authenticate separately here
      if (!app.isAuthenticated(req)) {
        socket.close(4401, 'unauthorized')
        return
      }
      this.#clients.add(socket)
      socket.on('close', () => this.#clients.delete(socket))
      socket.on('error', () => this.#clients.delete(socket))
    })
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event)
    for (const socket of this.#clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload)
      }
    }
  }
}
```

`socket.close(4401)` uses the application-defined close code range (4000–4999), which the frontend uses to distinguish "needs to log in again" from "network dropped" — the former should not reconnect forever.

- [ ] **Step 7: Wire it up in app.ts**

```ts
import websocket from '@fastify/websocket'
import { VaultWatcher } from './watcher.js'
import { WsHub } from './ws.js'

export interface AppDeps {
  config: Config
  vault: Vault
  git: VaultGit
}

export interface App {
  instance: FastifyInstance
  hub: WsHub
  watcher: VaultWatcher
}

export function buildApp(deps: AppDeps): App {
  const app = Fastify({ logger: false })
  const hub = new WsHub()
  const watcher = new VaultWatcher({
    root: deps.config.vaultRoot,
    onEvent: (event) => hub.broadcast(event),
  })

  app.register(cookie, { secret: deps.config.sessionSecret })
  app.register(websocket)
  app.register(async (instance) => {
    registerAuth(instance, deps.config)
    registerFileRoutes(instance, { ...deps, watcher })
    hub.registerRoute(instance)
  })

  app.addHook('onClose', async () => {
    await watcher.stop()
  })

  return { instance: app, hub, watcher }
}
```

`buildApp`'s return type changes from `FastifyInstance` to `App`. **`tests/server/helpers/app.ts` must be updated in step**:

```ts
  const built = buildApp({ config, vault: new Vault(root), git: new VaultGit(root) })
  const app = built.instance
  await app.ready()
```

Change the type of the `app` field in the `TestApp` interface to `FastifyInstance`.

- [ ] **Step 8: Make the write routes mark self-writes**

Extend `registerFileRoutes`'s `deps` type to `AppDeps & { watcher: VaultWatcher }`. In all four of `PUT /api/file`, `POST /api/file`, `POST /api/file/rename`, and `DELETE /api/file`, add `deps.watcher.markSelfWrite(...)` **before** calling vault:

```ts
      deps.watcher.markSelfWrite(relPath)
      return await vault.write(relPath, content)
```

rename has to mark two paths:

```ts
      deps.watcher.markSelfWrite(from)
      deps.watcher.markSelfWrite(to)
      await vault.rename(from, to)
```

Mark first, then write — the order cannot be reversed, because marking after writing means the fs event may already have arrived.

- [ ] **Step 9: Run all backend tests and confirm they pass**

Run: `pnpm vitest run --project server`
Expected: PASS, Tasks 1–7 all green

- [ ] **Step 10: Commit**

```bash
git add src/shared/events.ts src/server/watcher.ts src/server/ws.ts src/server/app.ts src/server/routes/files.ts tests/server/watcher.test.ts tests/server/helpers/app.ts
git commit -m "feat(watcher): add debounced fs watcher and websocket broadcast hub"
```

---

### Task 8: The periodic commit scheduler

**Files:**
- Create: `src/server/autocommit.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/routes/files.ts`
- Test: `tests/server/autocommit.test.ts`

**Interfaces:**
- Consumes: `VaultGit`（Task 4）
- Produces:

```ts
export interface AutoCommitOptions {
  git: VaultGit
  intervalMs?: number          // default 5 * 60 * 1000
  now?: () => number           // injectable for testing
  onCommit?: (sha: string, files: string[]) => void
  onError?: (err: unknown) => void
}
export class AutoCommit {
  constructor(opts: AutoCommitOptions)
  /** Called after every disk write, recording that there are changes pending commit */
  notifyWrite(): void
  /** Checks once whether it is time to commit. The timer calls it, and tests call it directly */
  tick(): Promise<void>
  /** Commits immediately (used before and after a codex turn); returns null when there are no changes */
  commitNow(message: string): Promise<CommitResult | null>
  start(): void
  stop(): void
}
```

Design point: the scheduler does **not** use `setInterval` to commit unconditionally every 5 minutes; it commits only when there are changes and more than intervalMs has passed since the last commit. Idle means zero activity, with no flooding of the git log.

- [ ] **Step 1: Write the failing autocommit tests**

`tests/server/autocommit.test.ts`：

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AutoCommit } from '../../src/server/autocommit.js'
import { VaultGit } from '../../src/server/git/index.js'

let root: string
let git: VaultGit
let clock: number

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-auto-'))
  const raw = simpleGit(root)
  await raw.init(['--initial-branch=main'])
  await raw.addConfig('user.email', 'test@example.com')
  await raw.addConfig('user.name', 'Test')
  await fs.writeFile(path.join(root, 'a.md'), 'one\n')
  await raw.add('.')
  await raw.commit('initial')
  git = new VaultGit(root)
  clock = 1_000_000
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function makeAuto(intervalMs = 1000) {
  return new AutoCommit({ git, intervalMs, now: () => clock })
}

async function commitCount(): Promise<number> {
  return (await simpleGit(root).log()).total
}

describe('AutoCommit.tick', () => {
  it('does not commit before the interval', async () => {
    const auto = makeAuto()
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    clock += 500
    await auto.tick()
    expect(await commitCount()).toBe(1)
  })

  it('commits once the interval is reached and there are changes', async () => {
    const auto = makeAuto()
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    clock += 1500
    await auto.tick()
    expect(await commitCount()).toBe(2)
    const log = await simpleGit(root).log()
    expect(log.latest?.message).toMatch(/^autosave:/)
  })

  it('does not commit past the interval when there are no changes', async () => {
    const auto = makeAuto()
    clock += 10_000
    await auto.tick()
    expect(await commitCount()).toBe(1)
  })

  it('does not commit when notifyWrite has not been called, even with a dirty working tree', async () => {
    const auto = makeAuto()
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    clock += 10_000
    await auto.tick()
    expect(await commitCount()).toBe(1)
  })

  it('resets the clock after committing, so two consecutive ticks commit only once', async () => {
    const auto = makeAuto()
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    clock += 1500
    await auto.tick()
    clock += 100
    await auto.tick()
    expect(await commitCount()).toBe(2)
  })

  it('the commit message contains the changed filenames', async () => {
    const auto = makeAuto()
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    clock += 1500
    await auto.tick()
    expect((await simpleGit(root).log()).latest?.message).toContain('a.md')
  })
})

describe('AutoCommit.commitNow', () => {
  it('commits immediately, ignoring the interval', async () => {
    const auto = makeAuto(999_999)
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    const result = await auto.commitNow('wip: before codex turn')
    expect(result).not.toBeNull()
    expect((await simpleGit(root).log()).latest?.message).toBe('wip: before codex turn')
  })

  it('returns null when there are no changes', async () => {
    const auto = makeAuto()
    expect(await auto.commitNow('nothing')).toBeNull()
  })

  it('clears the pending-commit marker after committing', async () => {
    const auto = makeAuto(1000)
    await fs.writeFile(path.join(root, 'a.md'), 'two\n')
    auto.notifyWrite()
    await auto.commitNow('manual')
    clock += 5000
    await auto.tick()
    expect(await commitCount()).toBe(2)
  })
})

describe('AutoCommit error handling', () => {
  it('calls onError without throwing when git fails', async () => {
    const errors: unknown[] = []
    const broken = new VaultGit(path.join(root, 'does-not-exist'))
    const auto = new AutoCommit({
      git: broken,
      intervalMs: 1,
      now: () => clock,
      onError: (e) => errors.push(e),
    })
    auto.notifyWrite()
    clock += 100
    await expect(auto.tick()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})
```

`tick()` is a public method rather than a private timer callback precisely so these cases can drive it exactly with an injected clock, without depending on real timers.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/server/autocommit.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: First split stageAll / commitStaged out of VaultGit**

AutoCommit needs to know which files are about to be committed before generating the commit message from them. `commitAll` binds the two together, so split it apart first. Modify `src/server/git/index.ts`:

```ts
  /** Stages all changes and returns the list of files that will be committed (an empty array means there is nothing to commit). */
  async stageAll(): Promise<string[]> {
    await this.#git.add(['-A'])
    const staged = await this.#git.status()
    return [...staged.staged, ...staged.renamed.map((r) => r.to)].sort()
  }

  /** Commits what is staged. stageAll must have run first and its list confirmed non-empty. */
  async commitStaged(message: string): Promise<string> {
    await this.#git.commit(message)
    return this.#git.revparse(['HEAD'])
  }

  async commitAll(message: string): Promise<CommitResult | null> {
    const files = await this.stageAll()
    if (files.length === 0) return null
    const sha = await this.commitStaged(message)
    return { sha, files }
  }
```

`commitAll`'s external behaviour is unchanged. Run once to confirm Task 4 is not broken:

Run: `pnpm vitest run tests/server/git/git.test.ts`
Expected: PASS, all 10 cases still green

- [ ] **Step 4: Implement autocommit.ts**

```ts
import type { CommitResult, VaultGit } from './git/index.js'

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
const MAX_FILES_IN_MESSAGE = 3

export interface AutoCommitOptions {
  git: VaultGit
  intervalMs?: number
  now?: () => number
  onCommit?: (sha: string, files: string[]) => void
  onError?: (err: unknown) => void
}

function buildMessage(files: string[]): string {
  const shown = files.slice(0, MAX_FILES_IN_MESSAGE).join(', ')
  const rest = files.length - MAX_FILES_IN_MESSAGE
  return rest > 0 ? `autosave: ${shown} (+${rest} more)` : `autosave: ${shown}`
}

export class AutoCommit {
  readonly #git: VaultGit
  readonly #intervalMs: number
  readonly #now: () => number
  readonly #onCommit?: (sha: string, files: string[]) => void
  readonly #onError?: (err: unknown) => void

  #dirty = false
  #lastCommitAt: number
  #timer: NodeJS.Timeout | null = null
  #running = false

  constructor(opts: AutoCommitOptions) {
    this.#git = opts.git
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.#now = opts.now ?? (() => Date.now())
    this.#onCommit = opts.onCommit
    this.#onError = opts.onError
    this.#lastCommitAt = this.#now()
  }

  notifyWrite(): void {
    this.#dirty = true
  }

  async tick(): Promise<void> {
    if (!this.#dirty) return
    if (this.#now() - this.#lastCommitAt < this.#intervalMs) return
    await this.#commit((files) => buildMessage(files))
  }

  async commitNow(message: string): Promise<CommitResult | null> {
    return this.#commit(() => message)
  }

  async #commit(message: (files: string[]) => string): Promise<CommitResult | null> {
    // prevents tick and commitNow from entering git concurrently and producing interleaved index operations
    if (this.#running) return null
    this.#running = true
    try {
      const files = await this.#git.stageAll()
      if (files.length === 0) {
        this.#dirty = false
        this.#lastCommitAt = this.#now()
        return null
      }
      const sha = await this.#git.commitStaged(message(files))
      this.#dirty = false
      this.#lastCommitAt = this.#now()
      this.#onCommit?.(sha, files)
      return { sha, files }
    } catch (err) {
      this.#onError?.(err)
      return null
    } finally {
      this.#running = false
    }
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => {
      void this.tick()
    }, Math.min(this.#intervalMs, 30_000))
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run tests/server/autocommit.test.ts tests/server/git/git.test.ts`
Expected: PASS, the 10 autocommit and 10 git cases all green

- [ ] **Step 6: Wire it up in app.ts, notifying after each write**

Add `autoCommit: AutoCommit` to `AppDeps`, have `buildApp` pass it to `registerFileRoutes`, and call `deps.autoCommit.notifyWrite()` after `PUT /api/file` and `DELETE /api/file` succeed. Add an `autoCommit` field to the `App` interface. Add `deps.autoCommit.stop()` to the `onClose` hook.

Construct it correspondingly in the test helper:

```ts
  const gitWrapper = new VaultGit(root)
  const autoCommit = new AutoCommit({ git: gitWrapper })
  const built = buildApp({ config, vault: new Vault(root), git: gitWrapper, autoCommit })
```

- [ ] **Step 7: Run all backend tests and confirm they pass**

Run: `pnpm vitest run --project server`
Expected: PASS, Tasks 1–8 all green

- [ ] **Step 8: Commit**

```bash
git add src/server/autocommit.ts src/server/git/index.ts src/server/app.ts src/server/routes/files.ts tests/server/autocommit.test.ts tests/server/helpers/app.ts
git commit -m "feat(autocommit): commit vault changes on an idle-aware interval"
```

---

### Task 9: Frontend scaffolding, theme variables, and the layout shell

**Files:**
- Modify: `package.json` (add the frontend dependencies)
- Create: `vite.config.ts`, `index.html`
- Create: `src/web/main.tsx`, `src/web/App.tsx`
- Create: `src/web/theme/tokens.css`, `src/web/theme/base.css`, `src/web/theme/useTheme.ts`
- Create: `src/web/layout/Shell.tsx`, `src/web/layout/TopBar.tsx`, `src/web/layout/StatusBar.tsx`
- Create: `src/web/state/ui.ts`
- Test: `tests/web/theme.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:

```ts
// src/web/state/ui.ts
export const leftPanelOpen: Signal<boolean>
export const rightPanelOpen: Signal<boolean>
export const rightTab: Signal<'outline' | 'codex'>
export const theme: Signal<'light' | 'dark'>
export function toggleTheme(): void

// src/web/layout/Shell.tsx
export function Shell(props: {
  left: ComponentChildren
  center: ComponentChildren
  right: ComponentChildren
  topBar: ComponentChildren
  statusBar: ComponentChildren
}): VNode
```

- [ ] **Step 1: Add the frontend dependencies**

```bash
pnpm add preact @preact/signals
pnpm add -D @preact/preset-vite @testing-library/preact @testing-library/jest-dom
```

Add to `compilerOptions` in `tsconfig.json`:

```json
    "jsx": "react-jsx",
    "jsxImportSource": "preact"
```

- [ ] **Step 2: Create vite.config.ts and index.html**

`vite.config.ts`：

```ts
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [preact()],
  root: '.',
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7654',
      '/ws': { target: 'ws://127.0.0.1:7654', ws: true },
    },
  },
})
```

`index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Inkstone</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Write the theme CSS variables**

`src/web/theme/tokens.css` — every color is defined in this one file, and every other stylesheet references the variables:

```css
:root {
  --ink-bg: #ffffff;
  --ink-fg: #333333;
  --ink-fg-muted: #777777;
  --ink-link: #4183c4;
  --ink-code-bg: #f8f8f8;
  --ink-rule: #dfe2e5;
  --ink-sidebar-bg: #fafafa;
  --ink-sidebar-hover: #eeeeee;
  --ink-sidebar-active: #e4e4e4;
  --ink-selection: #b4d5fe;
  --ink-danger: #c0392b;

  --ink-font-body: "Open Sans", "Helvetica Neue", "PingFang SC", "Noto Sans CJK SC", sans-serif;
  --ink-font-mono: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --ink-font-size: 16px;
  --ink-line-height: 1.6;

  --ink-content-width: 860px;
  --ink-left-width: 260px;
  --ink-right-width: 320px;
  --ink-topbar-height: 32px;
  --ink-statusbar-height: 24px;
}

:root[data-theme="dark"] {
  --ink-bg: #363b40;
  --ink-fg: #b8bfc6;
  --ink-fg-muted: #8b939b;
  --ink-link: #7ba6c9;
  --ink-code-bg: #2e3033;
  --ink-rule: #4b5054;
  --ink-sidebar-bg: #31353a;
  --ink-sidebar-hover: #3b4045;
  --ink-sidebar-active: #43484e;
  --ink-selection: #3a5570;
  --ink-danger: #e07a6f;
}
```

`src/web/theme/base.css` — where the three disciplines land: no rounded corners, no shadows, no borders as separators.

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
}

body {
  background: var(--ink-bg);
  color: var(--ink-fg);
  font-family: var(--ink-font-body);
  font-size: var(--ink-font-size);
  line-height: var(--ink-line-height);
  -webkit-font-smoothing: antialiased;
}

::selection {
  background: var(--ink-selection);
}

button {
  font: inherit;
  color: inherit;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}

button:hover {
  color: var(--ink-link);
}

a {
  color: var(--ink-link);
  text-decoration: none;
}
```

- [ ] **Step 4: Write the failing theme test**

`tests/web/theme.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { applyTheme, readStoredTheme, THEME_STORAGE_KEY } from '../../src/web/theme/useTheme.js'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('applyTheme', () => {
  it('writes the data-theme attribute', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('persists to localStorage', () => {
    applyTheme('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('switching back to light also writes the attribute rather than removing it', () => {
    applyTheme('dark')
    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

describe('readStoredTheme', () => {
  it('falls back to light when nothing is stored', () => {
    expect(readStoredTheme()).toBe('light')
  })

  it('reads a stored value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    expect(readStoredTheme()).toBe('dark')
  })

  it('ignores an invalid value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    expect(readStoredTheme()).toBe('light')
  })
})
```

- [ ] **Step 5: Run the test and confirm it fails**

Run: `pnpm vitest run --project web`
Expected: FAIL, `useTheme.ts` does not exist

- [ ] **Step 6: Implement useTheme.ts and state/ui.ts**

`src/web/theme/useTheme.ts`：

```ts
export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'inkstone.theme'

export function readStoredTheme(): Theme {
  const raw = localStorage.getItem(THEME_STORAGE_KEY)
  return raw === 'dark' || raw === 'light' ? raw : 'light'
}

export function applyTheme(next: Theme): void {
  document.documentElement.setAttribute('data-theme', next)
  localStorage.setItem(THEME_STORAGE_KEY, next)
}
```

`src/web/state/ui.ts`：

```ts
import { signal } from '@preact/signals'
import { applyTheme, readStoredTheme, type Theme } from '../theme/useTheme.js'

export const leftPanelOpen = signal(true)
export const rightPanelOpen = signal(true)
export const rightTab = signal<'outline' | 'codex'>('outline')
export const theme = signal<Theme>(readStoredTheme())

export function toggleTheme(): void {
  const next: Theme = theme.value === 'light' ? 'dark' : 'light'
  theme.value = next
  applyTheme(next)
}

export function toggleLeftPanel(): void {
  leftPanelOpen.value = !leftPanelOpen.value
}

export function toggleRightPanel(): void {
  rightPanelOpen.value = !rightPanelOpen.value
}
```

- [ ] **Step 7: Implement the layout shell**

`src/web/layout/Shell.tsx`：

```tsx
import type { ComponentChildren } from 'preact'
import { leftPanelOpen, rightPanelOpen } from '../state/ui.js'
import './shell.css'

export interface ShellProps {
  topBar: ComponentChildren
  left: ComponentChildren
  center: ComponentChildren
  right: ComponentChildren
  statusBar: ComponentChildren
}

export function Shell(props: ShellProps) {
  return (
    <div class="ink-shell">
      <header class="ink-topbar">{props.topBar}</header>
      <div class="ink-body">
        {leftPanelOpen.value && <aside class="ink-left">{props.left}</aside>}
        <main class="ink-center">{props.center}</main>
        {rightPanelOpen.value && <aside class="ink-right">{props.right}</aside>}
      </div>
      <footer class="ink-statusbar">{props.statusBar}</footer>
    </div>
  )
}
```

`src/web/layout/shell.css`：

```css
.ink-shell {
  display: grid;
  grid-template-rows: var(--ink-topbar-height) 1fr var(--ink-statusbar-height);
  height: 100%;
}

.ink-body {
  display: flex;
  min-height: 0;
}

.ink-left,
.ink-right {
  background: var(--ink-sidebar-bg);
  overflow-y: auto;
  flex-shrink: 0;
}

.ink-left {
  width: var(--ink-left-width);
}

.ink-right {
  width: var(--ink-right-width);
}

.ink-center {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  background: var(--ink-bg);
}

.ink-topbar,
.ink-statusbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  background: var(--ink-sidebar-bg);
  color: var(--ink-fg-muted);
  font-size: 12px;
  user-select: none;
}
```

The sidebar and the center area are distinguished by the background contrast between `--ink-sidebar-bg` and `--ink-bg`, with not a single border — this is what "no borders as separators" means.

- [ ] **Step 8: Implement TopBar, StatusBar, and the App skeleton**

`src/web/layout/TopBar.tsx`：

```tsx
import { theme, toggleLeftPanel, toggleRightPanel, toggleTheme } from '../state/ui.js'

export interface TopBarProps {
  breadcrumb: string
  saveState: 'saved' | 'saving' | 'error'
}

const SAVE_LABEL: Record<TopBarProps['saveState'], string> = {
  saved: 'Saved',
  saving: 'Saving…',
  error: 'Save failed',
}

export function TopBar(props: TopBarProps) {
  return (
    <>
      <button type="button" onClick={toggleLeftPanel} title="Toggle file tree (Cmd/Ctrl+\\)">
        ☰
      </button>
      <span class="ink-breadcrumb">{props.breadcrumb || 'No file open'}</span>
      <span style={{ marginLeft: 'auto' }}>{SAVE_LABEL[props.saveState]}</span>
      <button type="button" onClick={toggleTheme} title="Toggle theme">
        {theme.value === 'light' ? '☾' : '☀'}
      </button>
      <button type="button" onClick={toggleRightPanel} title="Toggle right panel (Cmd/Ctrl+/)">
        ▤
      </button>
    </>
  )
}
```

`src/web/layout/StatusBar.tsx`：

```tsx
export interface StatusBarProps {
  words: number
  chars: number
  gitDirty: boolean
  gitBranch: string
}

export function StatusBar(props: StatusBarProps) {
  return (
    <>
      <span>{props.words} words</span>
      <span>{props.chars} chars</span>
      <span style={{ marginLeft: 'auto', color: props.gitDirty ? 'var(--ink-danger)' : undefined }}>
        {props.gitBranch}
        {props.gitDirty ? ' ●' : ''}
      </span>
    </>
  )
}
```

`src/web/main.tsx`：

```tsx
import { render } from 'preact'
import { App } from './App.js'
import './theme/tokens.css'
import './theme/base.css'
import { applyTheme, readStoredTheme } from './theme/useTheme.js'

applyTheme(readStoredTheme())

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')
render(<App />, root)
```

`src/web/App.tsx` is a placeholder for now; Tasks 11 and 12 fill in the real content:

```tsx
import { Shell } from './layout/Shell.js'
import { StatusBar } from './layout/StatusBar.js'
import { TopBar } from './layout/TopBar.js'

export function App() {
  return (
    <Shell
      topBar={<TopBar breadcrumb="" saveState="saved" />}
      left={<div />}
      center={<div />}
      right={<div />}
      statusBar={<StatusBar words={0} chars={0} gitDirty={false} gitBranch="main" />}
    />
  )
}
```

- [ ] **Step 9: Run the test and confirm it passes**

Run: `pnpm vitest run --project web && pnpm typecheck`
Expected: the 6 theme cases PASS, and the typecheck reports no errors

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json vite.config.ts index.html src/web tests/web
git commit -m "feat(web): add preact shell, typora theme tokens, and layout scaffolding"
```

---

### Task 10: The API client and the WebSocket reconnect state machine

**Files:**
- Create: `src/web/api/client.ts`
- Create: `src/web/api/socket.ts`
- Test: `tests/web/api/client.test.ts`
- Test: `tests/web/api/socket.test.ts`

**Interfaces:**
- Consumes: `ServerEvent` (Task 7's `src/shared/events.ts`)
- Produces:

```ts
// src/web/api/client.ts
export class ApiError extends Error { readonly status: number }
export class ConflictError extends ApiError {
  readonly disk: { content: string; mtimeMs: number }
}
export interface FileResponse { path: string; content: string; mtimeMs: number }
export const api: {
  login(password: string): Promise<void>
  tree(): Promise<VaultEntry[]>
  readFile(path: string): Promise<FileResponse>
  writeFile(path: string, content: string, baseMtimeMs?: number): Promise<{ mtimeMs: number }>
  createEntry(path: string, kind: 'file' | 'dir'): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  gitStatus(): Promise<{ dirty: boolean; branch: string }>
}

// src/web/api/socket.ts
export type SocketState = 'connecting' | 'open' | 'closed' | 'unauthorized'
export interface SocketOptions {
  url: string
  onEvent: (event: ServerEvent) => void
  onStateChange?: (state: SocketState) => void
  onReconnect?: () => void        // fires after a successful reconnect, to trigger a full state fetch
  factory?: (url: string) => WebSocketLike   // injected in tests
  now?: () => number
  schedule?: (fn: () => void, ms: number) => number
}
export class EventSocket {
  constructor(opts: SocketOptions)
  connect(): void
  close(): void
  get state(): SocketState
  get retryDelayMs(): number
}
```

Key behaviour: an ordinary disconnect uses exponential backoff (1s → 2s → 4s → … capped at 30s, with ±20% jitter); receiving close code 4401 means the session is invalid, so it **stops reconnecting** and sets the state to `unauthorized`, with the UI guiding the user to log in again. Every successful reconnect fires `onReconnect`, which the frontend uses to re-fetch the file tree, the current file's mtime, and git status — because the events that occurred during the disconnect are permanently lost.

- [ ] **Step 1: Write the failing client test**

`tests/web/api/client.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, ConflictError } from '../../../src/web/api/client.js'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('api.readFile', () => {
  it('URL-encodes the path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: 'a b.md', content: 'x', mtimeMs: 1 }))
    await api.readFile('notes/a b.md')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/file?path=notes%2Fa%20b.md')
  })

  it('404 throws ApiError carrying the status code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    await expect(api.readFile('nope.md')).rejects.toMatchObject({ status: 404 })
  })
})

describe('api.writeFile', () => {
  it('includes baseMtimeMs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mtimeMs: 2 }))
    await api.writeFile('a.md', 'body', 1)
    const init = fetchMock.mock.calls[0][1]
    expect(JSON.parse(init.body)).toEqual({ path: 'a.md', content: 'body', baseMtimeMs: 1 })
  })

  it('omits the field when baseMtimeMs is not supplied', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mtimeMs: 2 }))
    await api.writeFile('a.md', 'body')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ path: 'a.md', content: 'body' })
  })

  it('409 throws ConflictError carrying the disk content', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'file changed on disk', disk: { content: 'theirs', mtimeMs: 9 } }, 409),
    )
    await expect(api.writeFile('a.md', 'mine', 1)).rejects.toBeInstanceOf(ConflictError)
    await expect(api.writeFile('a.md', 'mine', 1)).rejects.toMatchObject({
      disk: { content: 'theirs', mtimeMs: 9 },
    })
  })
})

describe('api.login', () => {
  it('a wrong password throws 401', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    await expect(api.login('wrong')).rejects.toBeInstanceOf(ApiError)
  })

  it('does not throw on success', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(api.login('right')).resolves.toBeUndefined()
  })
})

describe('204 responses', () => {
  it('remove does not try to parse an empty body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(api.remove('a.md')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/api/client.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement client.ts**

```ts
import type { VaultEntry } from '../../shared/types.js'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class ConflictError extends ApiError {
  constructor(
    message: string,
    readonly disk: { content: string; mtimeMs: number },
  ) {
    super(message, 409)
    this.name = 'ConflictError'
  }
}

export interface FileResponse {
  path: string
  content: string
  mtimeMs: number
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
  })

  if (res.status === 204) return undefined as T

  const body = res.headers.get('content-type')?.includes('application/json')
    ? await res.json()
    : null

  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    if (res.status === 409 && body && typeof body === 'object' && 'disk' in body) {
      throw new ConflictError(message, (body as { disk: { content: string; mtimeMs: number } }).disk)
    }
    throw new ApiError(message, res.status)
  }

  return body as T
}

export const api = {
  async login(password: string): Promise<void> {
    await request<void>('/api/login', { method: 'POST', body: JSON.stringify({ password }) })
  },

  tree(): Promise<VaultEntry[]> {
    return request<VaultEntry[]>('/api/tree')
  },

  readFile(path: string): Promise<FileResponse> {
    return request<FileResponse>(`/api/file?path=${encodeURIComponent(path)}`)
  },

  writeFile(path: string, content: string, baseMtimeMs?: number): Promise<{ mtimeMs: number }> {
    const payload: Record<string, unknown> = { path, content }
    if (baseMtimeMs !== undefined) payload.baseMtimeMs = baseMtimeMs
    return request<{ mtimeMs: number }>('/api/file', {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  },

  async createEntry(path: string, kind: 'file' | 'dir'): Promise<void> {
    await request<void>('/api/file', { method: 'POST', body: JSON.stringify({ path, kind }) })
  },

  async rename(from: string, to: string): Promise<void> {
    await request<void>('/api/file/rename', { method: 'POST', body: JSON.stringify({ from, to }) })
  },

  async remove(path: string): Promise<void> {
    await request<void>('/api/file', { method: 'DELETE', body: JSON.stringify({ path }) })
  },

  gitStatus(): Promise<{ dirty: boolean; branch: string }> {
    return request<{ dirty: boolean; branch: string }>('/api/git/status')
  },
}
```

Also move `VaultEntry` from `src/server/vault/index.ts` into `src/shared/types.ts` and re-export it from vault, so the frontend never imports a server module (which would drag `node:fs` into the browser bundle):

```ts
// src/shared/types.ts
export interface VaultEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: VaultEntry[]
}
```

Change the top of `src/server/vault/index.ts` to `export type { VaultEntry } from '../../shared/types.js'` and delete the local definition.

- [ ] **Step 4: Write the failing socket test**

`tests/web/api/socket.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { EventSocket, type SocketState } from '../../../src/web/api/socket.js'
import type { ServerEvent } from '../../../src/shared/events.js'

class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: (() => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  close() {
    this.closed = true
  }

  emitOpen() {
    this.onopen?.()
  }

  emitClose(code = 1006) {
    this.onclose?.({ code })
  }

  emitMessage(event: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

interface Harness {
  socket: EventSocket
  events: ServerEvent[]
  states: SocketState[]
  timers: Array<{ fn: () => void; ms: number }>
  runTimers: () => void
  reconnects: number
}

function makeHarness(): Harness {
  FakeSocket.instances = []
  const events: ServerEvent[] = []
  const states: SocketState[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  let reconnects = 0

  const socket = new EventSocket({
    url: '/ws',
    onEvent: (e) => events.push(e),
    onStateChange: (s) => states.push(s),
    onReconnect: () => {
      reconnects += 1
    },
    factory: (url) => new FakeSocket(url) as never,
    schedule: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
  })

  return {
    socket,
    events,
    states,
    timers,
    runTimers: () => {
      const pending = timers.splice(0, timers.length)
      for (const t of pending) t.fn()
    },
    get reconnects() {
      return reconnects
    },
  } as Harness
}

describe('EventSocket happy path', () => {
  it('the state is connecting after connect and open after open', () => {
    const h = makeHarness()
    h.socket.connect()
    expect(h.socket.state).toBe('connecting')
    FakeSocket.instances[0]!.emitOpen()
    expect(h.socket.state).toBe('open')
  })

  it('forwards parsed events', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    FakeSocket.instances[0]!.emitMessage({ type: 'tree-changed' })
    expect(h.events).toEqual([{ type: 'tree-changed' }])
  })

  it('discards unparseable messages without crashing', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    FakeSocket.instances[0]!.onmessage?.({ data: 'not json' })
    expect(h.events).toHaveLength(0)
    expect(h.socket.state).toBe('open')
  })
})

describe('EventSocket reconnect', () => {
  it('reconnects with exponential backoff after a disconnect', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()

    FakeSocket.instances[0]!.emitClose(1006)
    expect(h.timers[0]!.ms).toBeGreaterThanOrEqual(800)
    expect(h.timers[0]!.ms).toBeLessThanOrEqual(1200)

    h.runTimers()
    FakeSocket.instances[1]!.emitClose(1006)
    expect(h.timers[0]!.ms).toBeGreaterThanOrEqual(1600)
    expect(h.timers[0]!.ms).toBeLessThanOrEqual(2400)
  })

  it('the backoff is capped at 30s', () => {
    const h = makeHarness()
    h.socket.connect()
    for (let i = 0; i < 10; i += 1) {
      FakeSocket.instances.at(-1)!.emitClose(1006)
      h.runTimers()
    }
    FakeSocket.instances.at(-1)!.emitClose(1006)
    expect(h.timers[0]!.ms).toBeLessThanOrEqual(36_000)
  })

  it('the backoff resets and onReconnect fires after a successful reconnect', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    FakeSocket.instances[0]!.emitClose(1006)
    h.runTimers()
    FakeSocket.instances[1]!.emitOpen()

    expect(h.reconnects).toBe(1)
    FakeSocket.instances[1]!.emitClose(1006)
    expect(h.timers[0]!.ms).toBeLessThanOrEqual(1200)
  })

  it('the first open does not fire onReconnect', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    expect(h.reconnects).toBe(0)
  })
})

describe('EventSocket auth invalidation', () => {
  it('stops reconnecting and enters unauthorized after receiving 4401', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    FakeSocket.instances[0]!.emitClose(4401)
    expect(h.socket.state).toBe('unauthorized')
    expect(h.timers).toHaveLength(0)
  })
})

describe('EventSocket.close', () => {
  it('does not reconnect after an intentional close', () => {
    const h = makeHarness()
    h.socket.connect()
    FakeSocket.instances[0]!.emitOpen()
    h.socket.close()
    FakeSocket.instances[0]!.emitClose(1000)
    expect(h.timers).toHaveLength(0)
    expect(h.socket.state).toBe('closed')
  })
})
```

- [ ] **Step 5: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/api/socket.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 6: Implement socket.ts**

```ts
import type { ServerEvent } from '../../shared/events.js'

export type SocketState = 'connecting' | 'open' | 'closed' | 'unauthorized'

/** The custom close code for an invalidated session, matching socket.close(4401) in ws.ts. */
const UNAUTHORIZED_CODE = 4401
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000
const JITTER = 0.2

export interface WebSocketLike {
  onopen: (() => void) | null
  onclose: ((ev: { code: number }) => void) | null
  onmessage: ((ev: { data: string }) => void) | null
  onerror: (() => void) | null
  close(): void
}

export interface SocketOptions {
  url: string
  onEvent: (event: ServerEvent) => void
  onStateChange?: (state: SocketState) => void
  onReconnect?: () => void
  factory?: (url: string) => WebSocketLike
  random?: () => number
  schedule?: (fn: () => void, ms: number) => number
}

export class EventSocket {
  #state: SocketState = 'closed'
  #socket: WebSocketLike | null = null
  #attempt = 0
  #everOpened = false
  #manualClose = false
  #retryDelayMs = 0

  readonly #opts: Required<Pick<SocketOptions, 'factory' | 'random' | 'schedule'>> & SocketOptions

  constructor(opts: SocketOptions) {
    this.#opts = {
      ...opts,
      factory: opts.factory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike),
      random: opts.random ?? Math.random,
      schedule: opts.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number),
    }
  }

  get state(): SocketState {
    return this.#state
  }

  get retryDelayMs(): number {
    return this.#retryDelayMs
  }

  connect(): void {
    if (this.#state === 'unauthorized') return
    this.#manualClose = false
    this.#setState('connecting')

    const socket = this.#opts.factory(this.#opts.url)
    this.#socket = socket

    socket.onopen = () => {
      this.#attempt = 0
      this.#setState('open')
      if (this.#everOpened) this.#opts.onReconnect?.()
      this.#everOpened = true
    }

    socket.onmessage = (ev) => {
      try {
        this.#opts.onEvent(JSON.parse(ev.data) as ServerEvent)
      } catch {
        // an unparseable frame is simply discarded and does not affect the connection
      }
    }

    socket.onerror = () => {
      // a close event is always next, so the reconnect logic lives entirely in onclose
    }

    socket.onclose = (ev) => {
      this.#socket = null
      if (ev.code === UNAUTHORIZED_CODE) {
        this.#setState('unauthorized')
        return
      }
      if (this.#manualClose) {
        this.#setState('closed')
        return
      }
      this.#setState('closed')
      this.#scheduleReconnect()
    }
  }

  close(): void {
    this.#manualClose = true
    this.#socket?.close()
    this.#socket = null
    this.#setState('closed')
  }

  #scheduleReconnect(): void {
    const raw = Math.min(BASE_DELAY_MS * 2 ** this.#attempt, MAX_DELAY_MS)
    const jitter = 1 + (this.#opts.random() * 2 - 1) * JITTER
    this.#retryDelayMs = Math.round(raw * jitter)
    this.#attempt += 1
    this.#opts.schedule(() => this.connect(), this.#retryDelayMs)
  }

  #setState(next: SocketState): void {
    if (this.#state === next) return
    this.#state = next
    this.#opts.onStateChange?.(next)
  }
}
```

- [ ] **Step 7: Run the test and confirm it passes**

Run: `pnpm vitest run --project web`
Expected: PASS, the 7 client, 9 socket, and 6 theme cases all green

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/server/vault/index.ts src/web/api tests/web/api
git commit -m "feat(web): add typed api client and websocket reconnect state machine"
```

---

### Task 11: The file tree component

**Files:**
- Create: `src/web/state/vault.ts`
- Create: `src/web/filetree/FileTree.tsx`, `src/web/filetree/TreeNode.tsx`, `src/web/filetree/filetree.css`
- Modify: `src/web/App.tsx`
- Test: `tests/web/filetree.test.tsx`

**Interfaces:**
- Consumes: `api`（Task 10）、`VaultEntry`
- Produces:

```ts
// src/web/state/vault.ts
export const tree: Signal<VaultEntry[]>
export const currentPath: Signal<string | null>
export const expandedDirs: Signal<Set<string>>
export async function refreshTree(): Promise<void>
export function toggleDir(path: string): void
export function isExpanded(path: string): boolean

// src/web/filetree/FileTree.tsx
export function FileTree(props: { onOpenFile: (path: string) => void }): VNode
```

- [ ] **Step 1: Write the failing file tree tests**

`tests/web/filetree.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTree } from '../../src/web/filetree/FileTree.js'
import { currentPath, expandedDirs, tree } from '../../src/web/state/vault.js'
import type { VaultEntry } from '../../src/shared/types.js'

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
})

describe('FileTree rendering', () => {
  it('renders the top-level entries', () => {
    render(<FileTree onOpenFile={() => {}} />)
    expect(screen.getByText('notes')).toBeTruthy()
    expect(screen.getByText('readme.md')).toBeTruthy()
  })

  it('directories are collapsed by default, with children hidden', () => {
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
  it('clicking a file fires onOpenFile', () => {
    const onOpenFile = vi.fn()
    render(<FileTree onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getByText('readme.md'))
    expect(onOpenFile).toHaveBeenCalledWith('readme.md')
  })

  it('clicking a directory does not fire onOpenFile', () => {
    const onOpenFile = vi.fn()
    render(<FileTree onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getByText('notes'))
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('the current file carries the selected class', () => {
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/filetree.test.tsx`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement state/vault.ts**

```ts
import { signal } from '@preact/signals'
import type { VaultEntry } from '../../shared/types.js'
import { api } from '../api/client.js'

export const tree = signal<VaultEntry[]>([])
export const currentPath = signal<string | null>(null)
export const expandedDirs = signal<Set<string>>(new Set())

export async function refreshTree(): Promise<void> {
  tree.value = await api.tree()
}

export function isExpanded(path: string): boolean {
  return expandedDirs.value.has(path)
}

export function toggleDir(path: string): void {
  // copy into a new Set: signals trigger re-renders by reference change, and mutating in place will not update the UI
  const next = new Set(expandedDirs.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expandedDirs.value = next
}

/** Expands all ancestor directories of a file when it is opened. */
export function expandAncestors(filePath: string): void {
  const segments = filePath.split('/')
  const next = new Set(expandedDirs.value)
  for (let i = 1; i < segments.length; i += 1) {
    next.add(segments.slice(0, i).join('/'))
  }
  expandedDirs.value = next
}
```

- [ ] **Step 4: Implement TreeNode.tsx and FileTree.tsx**

`src/web/filetree/TreeNode.tsx`：

```tsx
import type { VaultEntry } from '../../shared/types.js'
import { currentPath, isExpanded, toggleDir } from '../state/vault.js'

const INDENT_PX = 14

export interface TreeNodeProps {
  entry: VaultEntry
  depth: number
  onOpenFile: (path: string) => void
}

export function TreeNode({ entry, depth, onOpenFile }: TreeNodeProps) {
  const expanded = entry.type === 'dir' && isExpanded(entry.path)
  const selected = currentPath.value === entry.path

  const handleClick = () => {
    if (entry.type === 'dir') toggleDir(entry.path)
    else onOpenFile(entry.path)
  }

  return (
    <>
      <div
        class={`ink-tree-row${selected ? ' selected' : ''}`}
        style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
        onClick={handleClick}
        role="treeitem"
        aria-expanded={entry.type === 'dir' ? expanded : undefined}
        aria-selected={selected}
      >
        <span class="ink-tree-caret">{entry.type === 'dir' ? (expanded ? '▾' : '▸') : ''}</span>
        <span class="ink-tree-name">{entry.name}</span>
      </div>
      {expanded &&
        entry.children?.map((child) => (
          <TreeNode key={child.path} entry={child} depth={depth + 1} onOpenFile={onOpenFile} />
        ))}
    </>
  )
}
```

`src/web/filetree/FileTree.tsx`：

```tsx
import { tree } from '../state/vault.js'
import './filetree.css'
import { TreeNode } from './TreeNode.js'

export interface FileTreeProps {
  onOpenFile: (path: string) => void
}

export function FileTree({ onOpenFile }: FileTreeProps) {
  if (tree.value.length === 0) {
    return <div class="ink-tree-empty">No notes yet</div>
  }
  return (
    <div class="ink-tree" role="tree">
      {tree.value.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} onOpenFile={onOpenFile} />
      ))}
    </div>
  )
}
```

`src/web/filetree/filetree.css`：

```css
.ink-tree {
  padding: 8px 0;
  font-size: 13px;
  user-select: none;
}

.ink-tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding-right: 8px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}

.ink-tree-row:hover {
  background: var(--ink-sidebar-hover);
}

.ink-tree-row.selected {
  background: var(--ink-sidebar-active);
}

.ink-tree-caret {
  width: 10px;
  color: var(--ink-fg-muted);
  flex-shrink: 0;
}

.ink-tree-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.ink-tree-empty {
  padding: 16px;
  color: var(--ink-fg-muted);
  font-size: 13px;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/filetree.test.tsx`
Expected: PASS, all 9 cases green

- [ ] **Step 6: Commit**

```bash
git add src/web/state/vault.ts src/web/filetree tests/web/filetree.test.tsx
git commit -m "feat(web): add collapsible file tree backed by vault signals"
```

---

### Task 12: The CodeMirror editor, autosave, and the conflict bar

**Files:**
- Create: `src/web/editor/Editor.tsx`, `src/web/editor/setup.ts`, `src/web/editor/editor.css`
- Create: `src/web/state/document.ts`
- Create: `src/web/components/ConflictBar.tsx`
- Modify: `src/web/App.tsx`
- Test: `tests/web/document.test.ts`

**Interfaces:**
- Consumes: `api`、`ConflictError`、`currentPath`、`expandAncestors`
- Produces:

```ts
// src/web/state/document.ts
export type SaveState = 'saved' | 'saving' | 'error'
export interface Conflict { diskContent: string; diskMtimeMs: number }

export const content: Signal<string>
export const baseMtimeMs: Signal<number | null>
export const saveState: Signal<SaveState>
export const saveError: Signal<string | null>
export const conflict: Signal<Conflict | null>
export const dirty: Signal<boolean>

export async function openFile(path: string): Promise<void>
export function editContent(next: string): void
export async function flushSave(): Promise<void>
export function resolveConflictTakeDisk(): void
export async function resolveConflictKeepMine(): Promise<void>
export function handleExternalChange(path: string, mtimeMs: number): Promise<void>

export const DRAFT_KEY_PREFIX = 'inkstone.draft:'
```

**The three autosave rules** (written into the implementation, not left to good intentions):

1. Persist 1000ms after typing stops; the write request carries `baseMtimeMs`.
2. Every `editContent` synchronously writes a localStorage draft, cleared after a successful save. This is the fallback for a full disk or a permissions error.
3. When a save returns 409, **do not overwrite the disk**; set the `conflict` signal so `ConflictBar` appears and let the user decide.

- [ ] **Step 1: Write the failing document tests**

`tests/web/document.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictError } from '../../src/web/api/client.js'
import * as clientModule from '../../src/web/api/client.js'
import {
  baseMtimeMs,
  conflict,
  content,
  DRAFT_KEY_PREFIX,
  dirty,
  editContent,
  flushSave,
  handleExternalChange,
  openFile,
  resolveConflictKeepMine,
  resolveConflictTakeDisk,
  saveError,
  saveState,
} from '../../src/web/state/document.js'
import { currentPath } from '../../src/web/state/vault.js'

const readFile = vi.spyOn(clientModule.api, 'readFile')
const writeFile = vi.spyOn(clientModule.api, 'writeFile')

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  readFile.mockReset()
  writeFile.mockReset()
  currentPath.value = null
  content.value = ''
  baseMtimeMs.value = null
  conflict.value = null
  saveError.value = null
  saveState.value = 'saved'
  dirty.value = false
})

afterEach(() => {
  vi.useRealTimers()
})

describe('openFile', () => {
  it('loads the content and mtime', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: '# a', mtimeMs: 100 })
    await openFile('a.md')
    expect(content.value).toBe('# a')
    expect(baseMtimeMs.value).toBe(100)
    expect(currentPath.value).toBe('a.md')
    expect(dirty.value).toBe(false)
  })

  it('prefers the draft when one exists and marks it dirty', async () => {
    localStorage.setItem(`${DRAFT_KEY_PREFIX}a.md`, 'unsaved draft')
    readFile.mockResolvedValue({ path: 'a.md', content: '# a', mtimeMs: 100 })
    await openFile('a.md')
    expect(content.value).toBe('unsaved draft')
    expect(dirty.value).toBe(true)
  })
})

describe('autosave', () => {
  it('persists once after a 1000ms debounce', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    writeFile.mockResolvedValue({ mtimeMs: 2 })
    await openFile('a.md')

    editContent('a')
    editContent('ab')
    editContent('abc')
    expect(writeFile).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(writeFile).toHaveBeenCalledWith('a.md', 'abc', 1)
  })

  it('updates baseMtimeMs and clears the draft after a successful save', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    writeFile.mockResolvedValue({ mtimeMs: 42 })
    await openFile('a.md')
    editContent('changed')
    await vi.advanceTimersByTimeAsync(1000)

    expect(baseMtimeMs.value).toBe(42)
    expect(saveState.value).toBe('saved')
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBeNull()
  })

  it('writes the draft immediately on edit, without waiting for the debounce', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    await openFile('a.md')
    editContent('typed')
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBe('typed')
  })

  it('keeps the draft and sets error when a save fails', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    writeFile.mockRejectedValue(new clientModule.ApiError('disk full', 500))
    await openFile('a.md')
    editContent('changed')
    await vi.advanceTimersByTimeAsync(1000)

    expect(saveState.value).toBe('error')
    expect(saveError.value).toContain('disk full')
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}a.md`)).toBe('changed')
  })

  it('flushSave saves immediately, without waiting for the debounce', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    writeFile.mockResolvedValue({ mtimeMs: 2 })
    await openFile('a.md')
    editContent('now')
    await flushSave()
    expect(writeFile).toHaveBeenCalledTimes(1)
  })
})

describe('conflict', () => {
  it('sets conflict on 409 and does not modify the local content', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    writeFile.mockRejectedValue(
      new ConflictError('changed on disk', { content: 'theirs', mtimeMs: 9 }),
    )
    await openFile('a.md')
    editContent('mine')
    await vi.advanceTimersByTimeAsync(1000)

    expect(conflict.value).toEqual({ diskContent: 'theirs', diskMtimeMs: 9 })
    expect(content.value).toBe('mine')
  })

  it('takeDisk overwrites local with the disk content', async () => {
    conflict.value = { diskContent: 'theirs', diskMtimeMs: 9 }
    content.value = 'mine'
    resolveConflictTakeDisk()
    expect(content.value).toBe('theirs')
    expect(baseMtimeMs.value).toBe(9)
    expect(conflict.value).toBeNull()
    expect(dirty.value).toBe(false)
  })

  it('keepMine re-saves using the disk mtime as the baseline', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    await openFile('a.md')
    content.value = 'mine'
    conflict.value = { diskContent: 'theirs', diskMtimeMs: 9 }
    writeFile.mockResolvedValue({ mtimeMs: 10 })

    await resolveConflictKeepMine()
    expect(writeFile).toHaveBeenCalledWith('a.md', 'mine', 9)
    expect(conflict.value).toBeNull()
  })
})

describe('handleExternalChange', () => {
  it('does nothing when a file other than the current one changes', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    await openFile('a.md')
    readFile.mockClear()
    await handleExternalChange('other.md', 5)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('auto-reloads when the current file changes and local is clean', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    await openFile('a.md')
    readFile.mockResolvedValue({ path: 'a.md', content: 'from codex', mtimeMs: 5 })
    await handleExternalChange('a.md', 5)
    expect(content.value).toBe('from codex')
    expect(baseMtimeMs.value).toBe(5)
    expect(conflict.value).toBeNull()
  })

  it('shows the conflict bar without overwriting when the current file changes and local is dirty', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 1 })
    await openFile('a.md')
    editContent('mine')
    readFile.mockResolvedValue({ path: 'a.md', content: 'from codex', mtimeMs: 5 })

    await handleExternalChange('a.md', 5)
    expect(content.value).toBe('mine')
    expect(conflict.value).toEqual({ diskContent: 'from codex', diskMtimeMs: 5 })
  })

  it('ignores it when the mtime equals the local baseline (an echo of our own write)', async () => {
    readFile.mockResolvedValue({ path: 'a.md', content: 'x', mtimeMs: 7 })
    await openFile('a.md')
    readFile.mockClear()
    await handleExternalChange('a.md', 7)
    expect(readFile).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/web/document.test.ts`
Expected: FAIL, the module does not exist

- [ ] **Step 3: Implement state/document.ts**

```ts
import { signal } from '@preact/signals'
import { api, ConflictError } from '../api/client.js'
import { currentPath, expandAncestors } from './vault.js'

export const DRAFT_KEY_PREFIX = 'inkstone.draft:'
const SAVE_DEBOUNCE_MS = 1000

export type SaveState = 'saved' | 'saving' | 'error'

export interface Conflict {
  diskContent: string
  diskMtimeMs: number
}

export const content = signal('')
export const baseMtimeMs = signal<number | null>(null)
export const saveState = signal<SaveState>('saved')
export const saveError = signal<string | null>(null)
export const conflict = signal<Conflict | null>(null)
export const dirty = signal(false)

let saveTimer: ReturnType<typeof setTimeout> | null = null

function draftKey(path: string): string {
  return `${DRAFT_KEY_PREFIX}${path}`
}

function clearTimer(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

export async function openFile(path: string): Promise<void> {
  clearTimer()
  const file = await api.readFile(path)
  const draft = localStorage.getItem(draftKey(path))

  currentPath.value = path
  expandAncestors(path)
  baseMtimeMs.value = file.mtimeMs
  conflict.value = null
  saveError.value = null
  saveState.value = 'saved'

  if (draft !== null && draft !== file.content) {
    // the previous session had unpersisted content; prioritize keeping the user's text
    content.value = draft
    dirty.value = true
  } else {
    content.value = file.content
    dirty.value = false
  }
}

export function editContent(next: string): void {
  content.value = next
  dirty.value = true

  const path = currentPath.value
  if (path) {
    try {
      localStorage.setItem(draftKey(path), next)
    } catch {
      // a full localStorage must not block editing; persisting to disk is still the main path
    }
  }

  clearTimer()
  saveTimer = setTimeout(() => {
    void performSave()
  }, SAVE_DEBOUNCE_MS)
}

export async function flushSave(): Promise<void> {
  clearTimer()
  await performSave()
}

async function performSave(): Promise<void> {
  const path = currentPath.value
  if (!path || !dirty.value) return

  const snapshot = content.value
  saveState.value = 'saving'

  try {
    const result = await api.writeFile(path, snapshot, baseMtimeMs.value ?? undefined)
    baseMtimeMs.value = result.mtimeMs
    saveState.value = 'saved'
    saveError.value = null
    // the user may have typed more during the save; only unchanged content counts as truly clean
    if (content.value === snapshot) {
      dirty.value = false
      localStorage.removeItem(draftKey(path))
    }
  } catch (err) {
    if (err instanceof ConflictError) {
      conflict.value = { diskContent: err.disk.content, diskMtimeMs: err.disk.mtimeMs }
      saveState.value = 'error'
      saveError.value = 'The file has changed on disk'
      return
    }
    saveState.value = 'error'
    saveError.value = err instanceof Error ? err.message : String(err)
  }
}

export function resolveConflictTakeDisk(): void {
  const current = conflict.value
  if (!current) return
  content.value = current.diskContent
  baseMtimeMs.value = current.diskMtimeMs
  dirty.value = false
  conflict.value = null
  saveState.value = 'saved'
  saveError.value = null
  const path = currentPath.value
  if (path) localStorage.removeItem(draftKey(path))
}

export async function resolveConflictKeepMine(): Promise<void> {
  const current = conflict.value
  if (!current) return
  // use the disk mtime as the new baseline, so the next write will not hit 409 again
  baseMtimeMs.value = current.diskMtimeMs
  conflict.value = null
  dirty.value = true
  await performSave()
}

export async function handleExternalChange(path: string, mtimeMs: number): Promise<void> {
  if (path !== currentPath.value) return
  if (baseMtimeMs.value !== null && Math.abs(mtimeMs - baseMtimeMs.value) <= 1) return

  const file = await api.readFile(path)

  if (!dirty.value) {
    content.value = file.content
    baseMtimeMs.value = file.mtimeMs
    saveState.value = 'saved'
    return
  }

  conflict.value = { diskContent: file.content, diskMtimeMs: file.mtimeMs }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run tests/web/document.test.ts`
Expected: PASS, all 14 cases green

- [ ] **Step 5: Implement ConflictBar**

`src/web/components/ConflictBar.tsx`：

```tsx
import { conflict, resolveConflictKeepMine, resolveConflictTakeDisk } from '../state/document.js'
import './conflictbar.css'

export function ConflictBar() {
  if (!conflict.value) return null
  return (
    <div class="ink-conflict" role="alert">
      <span>This file has changed on disk.</span>
      <button type="button" onClick={resolveConflictTakeDisk}>
        Use the disk version
      </button>
      <button type="button" onClick={() => void resolveConflictKeepMine()}>
        Keep mine
      </button>
    </div>
  )
}
```

`src/web/components/conflictbar.css`：

```css
.ink-conflict {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 16px;
  background: var(--ink-code-bg);
  color: var(--ink-fg);
  font-size: 13px;
  border-bottom: 1px solid var(--ink-rule);
}

.ink-conflict button {
  color: var(--ink-link);
}
```

This is the only place in the whole application that uses a border as a separator — the bar has to interrupt the visual flow to work at all, and it is a deliberate exception to "no borders as separators".

- [ ] **Step 6: Implement the editor**

`src/web/editor/setup.ts` — Phase 0 only needs plain source editing; Phase 1's live-preview extensions slot in where `livePreview()` sits:

```ts
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'

/** Typora's typographic rules realized in CodeMirror. Colors always reference the theme variables. */
const inkstoneTheme = EditorView.theme({
  '&': {
    fontSize: 'var(--ink-font-size)',
    color: 'var(--ink-fg)',
    backgroundColor: 'var(--ink-bg)',
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: 'var(--ink-font-body)',
    lineHeight: 'var(--ink-line-height)',
    overflow: 'auto',
  },
  '.cm-content': {
    maxWidth: 'var(--ink-content-width)',
    margin: '0 auto',
    padding: '30px 30px 100px',
    caretColor: 'var(--ink-fg)',
  },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--ink-selection)' },
  '.cm-cursor': { borderLeftColor: 'var(--ink-fg)' },
})

export interface SetupOptions {
  onChange: (value: string) => void
  onSaveShortcut: () => void
}

export function createExtensions(opts: SetupOptions): Extension[] {
  return [
    history(),
    drawSelection(),
    markdown(),
    inkstoneTheme,
    EditorView.lineWrapping,
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          opts.onSaveShortcut()
          return true
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString())
    }),
  ]
}

export function createState(doc: string, opts: SetupOptions): EditorState {
  return EditorState.create({ doc, extensions: createExtensions(opts) })
}
```

Install the dependencies first:

```bash
pnpm add @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/lang-markdown
```

`src/web/editor/Editor.tsx`：

```tsx
import { EditorView } from '@codemirror/view'
import { useEffect, useRef } from 'preact/hooks'
import { content, editContent, flushSave } from '../state/document.js'
import { currentPath } from '../state/vault.js'
import { createState } from './setup.js'

export function Editor() {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      state: createState(content.value, {
        onChange: editContent,
        onSaveShortcut: () => void flushSave(),
      }),
      parent: hostRef.current,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // when switching files, or when an external change replaces content wholesale, push the new document into the view.
  // content also changes as the user types, but the view is already up to date then, so the comparison lets us skip it.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const next = content.value
    if (view.state.doc.toString() === next) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
    })
  }, [content.value, currentPath.value])

  return <div class="ink-editor" ref={hostRef} />
}
```

`src/web/editor/editor.css`：

```css
.ink-editor {
  height: 100%;
}

.ink-editor .cm-editor {
  height: 100%;
}
```

- [ ] **Step 7: Wire up App.tsx**

```tsx
import { useEffect, useState } from 'preact/hooks'
import { api } from './api/client.js'
import { EventSocket } from './api/socket.js'
import { ConflictBar } from './components/ConflictBar.js'
import { Editor } from './editor/Editor.js'
import './editor/editor.css'
import { FileTree } from './filetree/FileTree.js'
import { Shell } from './layout/Shell.js'
import { StatusBar } from './layout/StatusBar.js'
import { TopBar } from './layout/TopBar.js'
import { content, handleExternalChange, openFile, saveState } from './state/document.js'
import { toggleLeftPanel, toggleRightPanel } from './state/ui.js'
import { currentPath, refreshTree } from './state/vault.js'

function countWords(text: string): number {
  // mixed CJK/Latin: count CJK per character, tokenize Latin by whitespace
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g)?.length ?? 0
  const latin = text.replace(/[\u4e00-\u9fff\u3040-\u30ff]/g, ' ').trim()
  return cjk + (latin ? latin.split(/\s+/).length : 0)
}

export function App() {
  const [git, setGit] = useState({ dirty: false, branch: 'main' })

  useEffect(() => {
    void refreshTree()
    void api.gitStatus().then(setGit)

    const socket = new EventSocket({
      url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      onEvent: (event) => {
        if (event.type === 'tree-changed') void refreshTree()
        else if (event.type === 'file-changed') {
          void handleExternalChange(event.path, event.mtimeMs)
        } else if (event.type === 'git-status') {
          setGit({ dirty: event.dirty, branch: event.branch })
        }
      },
      onReconnect: () => {
        // events during the disconnect are permanently lost, so after reconnecting we must re-align the full state
        void refreshTree()
        void api.gitStatus().then(setGit)
        const path = currentPath.value
        if (path) void api.readFile(path).then((f) => handleExternalChange(path, f.mtimeMs))
      },
    })
    socket.connect()

    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '\\') {
        e.preventDefault()
        toggleLeftPanel()
      } else if (e.key === '/') {
        e.preventDefault()
        toggleRightPanel()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      socket.close()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <Shell
      topBar={<TopBar breadcrumb={currentPath.value ?? ''} saveState={saveState.value} />}
      left={<FileTree onOpenFile={(path) => void openFile(path)} />}
      center={
        <>
          <ConflictBar />
          <Editor />
        </>
      }
      right={<div />}
      statusBar={
        <StatusBar
          words={countWords(content.value)}
          chars={content.value.length}
          gitDirty={git.dirty}
          gitBranch={git.branch}
        />
      }
    />
  )
}
```

- [ ] **Step 8: Run all frontend tests and the typecheck**

Run: `pnpm vitest run --project web && pnpm typecheck`
Expected: PASS, every frontend case passes with no type errors

- [ ] **Step 9: Commit**

```bash
git add package.json src/web tests/web/document.test.ts
git commit -m "feat(web): add codemirror editor with debounced autosave and conflict resolution"
```

---

### Task 13: Static serving, the entry point, and an end-to-end smoke test

**Files:**
- Create: `src/server/main.ts`
- Modify: `src/server/app.ts` (register static assets and the SPA fallback)
- Create: `src/web/components/LoginGate.tsx`
- Modify: `src/web/main.tsx`
- Create: `playwright.config.ts`, `tests/e2e/smoke.spec.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: every preceding module
- Produces: a runnable `node dist/server/main.js`

- [ ] **Step 1: Implement the login gate**

`/api/tree` returns 401 when not logged in, so the frontend needs a login screen rather than a blank page.

`src/web/components/LoginGate.tsx`：

```tsx
import { useState } from 'preact/hooks'
import { api, ApiError } from '../api/client.js'
import './logingate.css'

export interface LoginGateProps {
  onSuccess: () => void
}

export function LoginGate({ onSuccess }: LoginGateProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(password)
      onSuccess()
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Wrong password' : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form class="ink-login" onSubmit={submit}>
      <input
        type="password"
        value={password}
        placeholder="Password"
        autoFocus
        onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
      />
      <button type="submit" disabled={busy || password.length === 0}>
        Enter
      </button>
      {error && <p class="ink-login-error">{error}</p>}
    </form>
  )
}
```

`src/web/components/logingate.css`：

```css
.ink-login {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 240px;
  margin: 20vh auto 0;
}

.ink-login input {
  font: inherit;
  padding: 8px;
  color: var(--ink-fg);
  background: var(--ink-code-bg);
  border: none;
  outline: none;
}

.ink-login button {
  padding: 8px;
  background: var(--ink-code-bg);
  color: var(--ink-link);
}

.ink-login-error {
  margin: 0;
  color: var(--ink-danger);
  font-size: 13px;
}
```

Change `src/web/main.tsx` to probe the login state first:

```tsx
import { render } from 'preact'
import { useState } from 'preact/hooks'
import { App } from './App.js'
import { api, ApiError } from './api/client.js'
import { LoginGate } from './components/LoginGate.js'
import './theme/tokens.css'
import './theme/base.css'
import { applyTheme, readStoredTheme } from './theme/useTheme.js'

applyTheme(readStoredTheme())

function Root() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  if (authed === null) {
    void api
      .tree()
      .then(() => setAuthed(true))
      .catch((err) => setAuthed(!(err instanceof ApiError && err.status === 401)))
    return null
  }

  return authed ? <App /> : <LoginGate onSuccess={() => setAuthed(true)} />
}

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')
render(<Root />, root)
```

- [ ] **Step 2: Register static assets and the SPA fallback in app.ts**

```ts
import fastifyStatic from '@fastify/static'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// inside buildApp, after registerAuth
  const webRoot = path.resolve(fileURLToPath(new URL('../web', import.meta.url)))
  app.register(fastifyStatic, { root: webRoot, wildcard: false })

  app.setNotFoundHandler((req, reply) => {
    // API 404s stay JSON; every other path falls back to the SPA entry point
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' })
    }
    return reply.sendFile('index.html')
  })
```

Add an optional `webRoot?: string` override to `AppDeps`, passing an empty directory in tests to avoid depending on build output. If the `webRoot` directory does not exist (running only the backend in development), skip registering `fastifyStatic`.

- [ ] **Step 3: Implement main.ts**

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AutoCommit } from './autocommit.js'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { VaultGit } from './git/index.js'
import { Vault } from './vault/index.js'

const execFileAsync = promisify(execFile)

async function preflight(codexBin: string, git: VaultGit): Promise<void> {
  if (!(await git.isRepo())) {
    throw new Error(`VAULT_ROOT is not a git repository: ${git.root} — run 'git init' there first`)
  }
  try {
    const { stdout } = await execFileAsync(codexBin, ['--version'])
    console.log(`codex: ${stdout.trim()}`)
  } catch {
    // Phase 0 does not use codex, so a missing binary only warns and does not block startup
    console.warn(`codex not found at '${codexBin}' — the Codex panel will be unavailable`)
  }
}

const config = loadConfig(process.env)
const vault = new Vault(config.vaultRoot)
const git = new VaultGit(config.vaultRoot)
const autoCommit = new AutoCommit({
  git,
  onError: (err) => console.error('autocommit failed:', err),
})

await preflight(config.codexBin, git)

const { instance, watcher } = buildApp({ config, vault, git, autoCommit })
await watcher.start()
autoCommit.start()

await instance.listen({ host: config.listenAddr, port: config.port })
console.log(`inkstone listening on http://${config.listenAddr}:${config.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void instance.close().then(() => process.exit(0))
  })
}
```

- [ ] **Step 4: Write the end-to-end smoke test**

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

`playwright.config.ts`：

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:7699' },
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: 'http://127.0.0.1:7699/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
```

`tests/e2e/server.mjs` — starts a real service against a temporary vault:

```js
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkstone-e2e-'))
fs.mkdirSync(path.join(root, 'notes'), { recursive: true })
fs.writeFileSync(path.join(root, 'notes', 'hello.md'), '# hello\n')

const runGit = (args) => execFileSync('git', args, { cwd: root })
runGit(['init', '--initial-branch=main'])
runGit(['config', 'user.email', 'e2e@example.com'])
runGit(['config', 'user.name', 'E2E'])
runGit(['add', '.'])
runGit(['commit', '-m', 'initial'])

process.env.VAULT_ROOT = root
process.env.AUTH_PASSWORD = 'e2e-password'
process.env.SESSION_SECRET = 'e2e-session-secret'
process.env.PORT = '7699'
process.env.LISTEN_ADDR = '127.0.0.1'

await import('../../dist/server/main.js')
```

`tests/e2e/smoke.spec.ts`：

```ts
import { expect, test } from '@playwright/test'

test('log in, open a file, edit, and the content is still there after a reload', async ({ page }) => {
  await page.goto('/')

  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()

  await expect(page.getByText('notes')).toBeVisible()
  await page.getByText('notes').click()
  await page.getByText('hello.md').click()

  const editor = page.locator('.cm-content')
  await expect(editor).toContainText('# hello')

  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type('\n\npersistence-test')

  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })

  await page.reload()
  await page.getByText('notes').click()
  await page.getByText('hello.md').click()
  await expect(page.locator('.cm-content')).toContainText('persistence-test')
})

test('stays on the login page when the password is wrong', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('wrong')
  await page.getByRole('button', { name: 'Enter' }).click()
  await expect(page.getByText('Wrong password')).toBeVisible()
})
```

Add the scripts to `package.json`:

```json
    "test:e2e": "pnpm build && playwright test"
```

- [ ] **Step 5: Build and get the end-to-end suite passing**

Run: `pnpm build && pnpm exec playwright test`
Expected: 2 cases PASS

If the output path of `dist/web` does not match what `app.ts` derives from `../web`, adjust `build.outDir` in `vite.config.ts` or the `webRoot` derivation, so that `../web` relative to `dist/server/main.js` points exactly at `dist/web`.

- [ ] **Step 6: Write the README**

`README.md`：

````markdown
# Inkstone

A web Typora you host yourself, with a codex-CLI note assistant built in.

## Requirements

- Node 22+、pnpm
- The vault directory must already be a git repository (`git init`)
- (From Phase 2) the codex CLI installed and logged in on the server

## Configuration

| Variable | Default | Description |
|---|---|---|
| `VAULT_ROOT` | required | Vault root directory; must be a git repository |
| `AUTH_PASSWORD` | required | Login password |
| `SESSION_SECRET` | required | Cookie signing key; must differ from the password |
| `LISTEN_ADDR` | `127.0.0.1` | Bind address. Set this to the Tailscale interface address when deploying — **never** `0.0.0.0` |
| `PORT` | `7654` | Listen port |
| `CODEX_BIN` | `codex` | Path to the codex executable |

## Development

```bash
pnpm install
pnpm dev:server    # backend, 7654
pnpm dev:web       # frontend, Vite proxies to the backend
pnpm test          # unit tests
pnpm test:e2e      # end to end
```

## Deployment

```bash
pnpm build
node dist/server/main.js
```

See `docs/deploy.md` for an example systemd unit.

## Security

The service has no multi-user isolation and (from Phase 2) spawns a codex process on the server with write access to the vault. **Bind it only to an intranet or Tailscale address; do not expose it to the public internet.**
````

- [ ] **Step 7: Get the whole test suite passing**

Run: `pnpm typecheck && pnpm test && pnpm test:e2e`
Expected: all green

- [ ] **Step 8: Commit**

```bash
git add src/server/main.ts src/server/app.ts src/web/main.tsx src/web/components playwright.config.ts tests/e2e README.md package.json
git commit -m "feat: add server entrypoint, static hosting, login gate, and e2e smoke tests"
```

---

## Phase 0 completion criteria

- [ ] `pnpm typecheck` reports no errors
- [ ] `pnpm test` all green (~60 backend cases, ~36 frontend cases)
- [ ] `pnpm test:e2e` all green
- [ ] Manual check: after `VAULT_ROOT=<a real notes directory> node dist/server/main.js`, you can log in, browse, edit, and autosave
- [ ] Manual check: editing a file that is not open with `vim` on the server refreshes the browser's file tree automatically
- [ ] Manual check: editing the currently open file (with unsaved changes) with `vim` on the server raises the conflict bar in the browser
- [ ] Manual check: after editing and waiting 5 minutes, `git log` shows an `autosave:` commit

