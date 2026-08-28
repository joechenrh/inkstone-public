import type { FileCommit, PendingChange, VaultEntry } from '../../shared/types.js'

/**
 * Everything the app needs from wherever the notes live.
 *
 * The app had this boundary already, by accident: one object, one file, and no other `fetch` in
 * the web source. Naming it costs nothing and buys the ability to put something other than this
 * server behind it — see `docs/design/public-route.md`, where the something else is the user's own
 * GitHub repository, reached from the browser.
 *
 * Four things here are deliberately *not* the shape the server hands over, because those shapes
 * are facts about a filesystem rather than about a vault: `Rev` instead of an mtime, `modifiedAt`
 * separated from it, events delivered by the backend rather than by a WebSocket the app opens
 * itself, and a `label` where there was an absolute path. Authentication is not here at all — it
 * is not a vault operation, and GitHub's is a redirect rather than a request.
 */
export interface VaultBackend {
  /** What the status bar calls this vault: a path, or `owner/repo`. */
  info(): Promise<{ label: string }>

  /**
   * Start delivering events, and return the function that stops.
   *
   * `onReconnect` fires after a gap during which events were lost, so the app can re-read
   * everything it cannot know is still current. A backend with no push channel never calls either.
   */
  connect(handlers: { onEvent: (event: VaultEvent) => void; onReconnect?: () => void }): () => void

  /**
   * Whether two revs name the same version.
   *
   * Not `===`: this server's revs are file mtimes, and a write's own echo can come back a
   * millisecond off. Only the backend knows what its revs tolerate.
   */
  isSameRev(a: Rev | null, b: Rev | null): boolean

  tree(): Promise<VaultEntry[]>
  readFile(path: string): Promise<FileSnapshot>
  /** `base` is the rev the edit started from; a mismatch throws {@link ConflictError}. */
  writeFile(path: string, content: string, base?: Rev): Promise<WriteResult>
  createEntry(path: string, kind: 'file' | 'dir'): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  corpus(): Promise<{ notes: { path: string; text: string }[]; truncated: boolean }>

  /**
   * Store a picture and return the path a note should refer to it by.
   *
   * The name is not an argument: it is the hash of the bytes, decided by whoever stores them. The
   * same picture pasted into two notes is written once and linked twice, and a name can never come
   * to mean different bytes — which is what lets it be cached for ever.
   */
  writeAsset(bytes: Uint8Array, ext: string): Promise<{ path: string; existed: boolean }>

  /**
   * A URL the browser can put in `src`, for a path a note refers to.
   *
   * The note says `/assets/a1b2c3d4.webp`, which a browser would resolve against the page — wrong
   * in both routes. Turning a path into something displayable is a fact about where the notes
   * live, so it belongs here rather than in an editor: every rendering bug worth the name in this
   * project has been a fact about the document written down somewhere only one editor could read.
   */
  assetUrl(path: string): Promise<string | null>

  /**
   * A page a person can open for that file, on whatever holds it — or null when there is none.
   *
   * Not the same question as {@link assetUrl}, which answers "what goes in `src`". Reading a
   * repository from GitHub, `src` is a `blob:` URL over bytes this tab downloaded: it shows the
   * picture, and it is useless as a link — the address bar says this application's origin, the URL
   * dies with the tab that made it, and it cannot be reloaded or sent to anyone. Opening a picture
   * is a different gesture from displaying one, and the reader is signed in to GitHub already.
   *
   * Null where the answer is already `assetUrl` — the vault serves its own files from a real,
   * reloadable address.
   */
  assetPage(path: string): Promise<string | null>

  /**
   * Let go of whatever was being held to show pictures.
   *
   * Called when the open note changes. `createObjectURL` keeps its blob alive until it is revoked,
   * and a reader who visits forty notes should not be carrying forty of them — so the URLs live
   * for the life of the note rather than of the session. A backend that hands out ordinary URLs
   * holds nothing and does nothing.
   */
  releaseAssets(): void

  gitStatus(): Promise<GitStatus>
  gitChanges(): Promise<{ changes: PendingChange[] }>
  commit(message: string): Promise<{ sha: string; files: string[] } | null>
  gitLog(path: string, limit?: number): Promise<{ commits: FileCommit[] }>
  /** `from` is the commit before the range; null diffs back to the file's first appearance. */
  gitDiff(path: string, from: string | null, to: string): Promise<{ diff: string }>
  fileAtCommit(path: string, sha: string): Promise<{ content: string }>
  push(): Promise<{ pushed: number }>
}

/**
 * Which version of a file the app is holding — a filesystem mtime here, a blob sha against a git
 * tree. **Opaque:** the app stores it and hands it back, and only the backend may read it.
 */
export type Rev = string

export interface FileSnapshot {
  path: string
  content: string
  rev: Rev
  /** Epoch ms, for display. Separate from `rev` because not every store's version is a time. */
  modifiedAt: number | null
}

export interface WriteResult {
  rev: Rev
  modifiedAt: number | null
}

export interface GitStatus {
  dirty: boolean
  branch: string
  hasRemote: boolean
  ahead: number
}

export type VaultEvent =
  | { type: 'tree-changed' }
  | { type: 'file-changed'; path: string; rev: Rev }
  | { type: 'file-removed'; path: string }
  | { type: 'git-status'; status: GitStatus }

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}

/** The file moved under the edit. `theirs` is the version that won, ready to show or adopt. */
export class ConflictError extends BackendError {
  constructor(
    message: string,
    readonly theirs: FileSnapshot,
  ) {
    super(message, 409)
    this.name = 'ConflictError'
  }
}
