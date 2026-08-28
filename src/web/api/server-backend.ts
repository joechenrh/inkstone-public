import type { ServerEvent } from '../../shared/events.js'
import type { FileCommit, PendingChange, VaultEntry } from '../../shared/types.js'
import { sessionLost } from '../state/session.js'
import {
  BackendError,
  ConflictError,
  type FileSnapshot,
  type GitStatus,
  type Rev,
  type VaultBackend,
  type WriteResult,
} from './backend.js'
import { EventSocket } from './socket.js'

/** How far apart two mtimes may be and still name the same write. */
const MTIME_GRACE_MS = 1

/**
 * A 409 as the server states it. Only `writeFile` knows which path it was writing, so the
 * app-facing {@link ConflictError} is assembled there rather than here.
 */
class DiskConflict extends BackendError {
  constructor(
    message: string,
    readonly disk: { content: string; mtimeMs: number },
  ) {
    super(message, 409)
    this.name = 'DiskConflict'
  }
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
    // Every request funnels through here, which is the only place that can notice the session
    // ending. The login request is exempt: a 401 there is a wrong password, not a lost session.
    if (res.status === 401 && !url.startsWith('/api/login')) sessionLost.value = true
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    if (res.status === 409 && body != null && typeof body === 'object' && 'disk' in body) {
      throw new DiskConflict(message, (body as { disk: { content: string; mtimeMs: number } }).disk)
    }
    throw new BackendError(message, res.status)
  }

  return body as T
}

/**
 * This server: the vault is a directory on its disk, reached over `/api/*`.
 *
 * Revs are file mtimes rendered as strings — opaque to the app, parsed back here at both ends.
 */
/** Base64 without a data URL round trip, in chunks so a large picture cannot blow the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export const serverBackend: VaultBackend = {
  async info(): Promise<{ label: string }> {
    const { root } = await request<{ root: string }>('/api/vault/info')
    return { label: root }
  },

  connect(handlers) {
    const socket = new EventSocket({
      url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      onEvent: (event: ServerEvent) => {
        if (event.type === 'file-changed') {
          handlers.onEvent({ type: 'file-changed', path: event.path, rev: String(event.mtimeMs) })
        } else if (event.type === 'git-status') {
          const { dirty, branch, hasRemote, ahead } = event
          handlers.onEvent({ type: 'git-status', status: { dirty, branch, hasRemote, ahead } })
        } else {
          handlers.onEvent(event)
        }
      },
      onReconnect: handlers.onReconnect,
    })
    socket.connect()
    return () => { socket.close() }
  },

  isSameRev(a: Rev | null, b: Rev | null): boolean {
    if (a === null || b === null) return false
    return Math.abs(Number(a) - Number(b)) <= MTIME_GRACE_MS
  },

  tree(): Promise<VaultEntry[]> {
    return request<VaultEntry[]>('/api/tree')
  },

  async readFile(path: string): Promise<FileSnapshot> {
    const file = await request<{ path: string; content: string; mtimeMs: number }>(
      `/api/file?path=${encodeURIComponent(path)}`,
    )
    return { path: file.path, content: file.content, rev: String(file.mtimeMs), modifiedAt: file.mtimeMs }
  },

  async writeFile(path: string, content: string, base?: Rev): Promise<WriteResult> {
    const payload: Record<string, unknown> = { path, content }
    if (base !== undefined) payload.baseMtimeMs = Number(base)
    try {
      const { mtimeMs } = await request<{ mtimeMs: number }>('/api/file', {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      return { rev: String(mtimeMs), modifiedAt: mtimeMs }
    } catch (err) {
      if (err instanceof DiskConflict) {
        throw new ConflictError(err.message, {
          path,
          content: err.disk.content,
          rev: String(err.disk.mtimeMs),
          modifiedAt: err.disk.mtimeMs,
        })
      }
      throw err
    }
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

  corpus(): Promise<{ notes: { path: string; text: string }[]; truncated: boolean }> {
    return request<{ notes: { path: string; text: string }[]; truncated: boolean }>('/api/corpus')
  },

  async writeAsset(bytes: Uint8Array, ext: string): Promise<{ path: string; existed: boolean }> {
    // Base64 rather than multipart: this arrives from a clipboard as bytes in a browser, and one
    // JSON request is less machinery than a form encoder on both ends.
    return request<{ path: string; existed: boolean }>('/api/asset', {
      method: 'POST',
      body: JSON.stringify({ bytes: toBase64(bytes), ext }),
    })
  },

  assetUrl(path: string): Promise<string | null> {
    // Served by this server, so the browser's own cache does the work — the route says `immutable`
    // and the name is the hash of the bytes, so it never has to ask twice.
    const rel = path.replace(/^\//, '')
    return Promise.resolve(rel.startsWith('assets/') ? `/api/asset?path=${encodeURIComponent(rel)}` : null)
  },

  /* The vault serves its own files, so `assetUrl` is already an address that survives being
     opened, reloaded and kept. There is nothing better to offer. */
  assetPage(): Promise<string | null> {
    return Promise.resolve(null)
  },

  releaseAssets(): void {
    // Nothing is held: the URLs above are ordinary ones the browser fetches and caches itself.
  },

  gitStatus(): Promise<GitStatus> {
    return request<GitStatus>('/api/git/status')
  },

  gitChanges(): Promise<{ changes: PendingChange[] }> {
    return request<{ changes: PendingChange[] }>('/api/git/changes')
  },

  commit(message: string): Promise<{ sha: string; files: string[] } | null> {
    return request<{ sha: string; files: string[] } | null>('/api/git/commit', { method: 'POST', body: JSON.stringify({ message }) })
  },

  gitLog(path: string, limit = 100): Promise<{ commits: FileCommit[] }> {
    return request<{ commits: FileCommit[] }>(`/api/git/log?path=${encodeURIComponent(path)}&limit=${limit}`)
  },

  gitDiff(path: string, from: string | null, to: string): Promise<{ diff: string }> {
    const fromParam = from === null ? '' : `&from=${encodeURIComponent(from)}`
    return request<{ diff: string }>(`/api/git/diff?path=${encodeURIComponent(path)}&to=${encodeURIComponent(to)}${fromParam}`)
  },

  fileAtCommit(path: string, sha: string): Promise<{ content: string }> {
    return request<{ content: string }>(`/api/git/file-at?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(sha)}`)
  },

  push(): Promise<{ pushed: number }> {
    return request<{ pushed: number }>('/api/git/push', { method: 'POST' })
  },
}

/**
 * Signing in, which is not a vault operation: this server checks a password, and the route in
 * `docs/design/public-route.md` redirects to GitHub instead. The two have no shape in common, so
 * they get no shared interface until there is a second one to share it with.
 */
export const auth = {
  async signIn(password: string): Promise<void> {
    await request<void>('/api/login', { method: 'POST', body: JSON.stringify({ password }) })
  },

  async signOut(): Promise<void> {
    await request<void>('/api/logout', { method: 'POST' })
  },
}
