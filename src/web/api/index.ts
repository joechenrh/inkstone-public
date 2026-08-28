import type { FileCommit, PendingChange, VaultEntry } from '../../shared/types.js'
import type {
  FileSnapshot,
  GitStatus,
  Rev,
  VaultBackend,
  VaultEvent,
  WriteResult,
} from './backend.js'
import { serverBackend } from './server-backend.js'

/**
 * Where the notes live.
 *
 * The shipped answer is this server, decided before anything renders. The other one — a branch of
 * the user's own GitHub repository, per `docs/design/public-route.md` — cannot be decided that
 * early: it is not known until the user has signed in and said which repository. So `backend` is a
 * fixed object that forwards to whichever implementation is installed, rather than the
 * implementation itself; the alternative was making every one of its twenty call sites ask for it.
 */
let impl: VaultBackend = serverBackend

/** Install a backend. Called once, before the app renders anything that would use it. */
export function useBackend(next: VaultBackend): void {
  impl = next
}

export const backend: VaultBackend = {
  info: () => impl.info(),
  connect: (handlers) => impl.connect(handlers),
  isSameRev: (a: Rev | null, b: Rev | null) => impl.isSameRev(a, b),
  tree: (): Promise<VaultEntry[]> => impl.tree(),
  readFile: (path: string): Promise<FileSnapshot> => impl.readFile(path),
  writeFile: (path: string, content: string, base?: Rev): Promise<WriteResult> =>
    impl.writeFile(path, content, base),
  createEntry: (path: string, kind: 'file' | 'dir') => impl.createEntry(path, kind),
  rename: (from: string, to: string) => impl.rename(from, to),
  remove: (path: string) => impl.remove(path),
  corpus: () => impl.corpus(),
  writeAsset: (bytes: Uint8Array, ext: string) => impl.writeAsset(bytes, ext),
  assetUrl: (path: string) => impl.assetUrl(path),
  assetPage: (path: string) => impl.assetPage(path),
  releaseAssets: () => { impl.releaseAssets() },
  gitStatus: (): Promise<GitStatus> => impl.gitStatus(),
  gitChanges: (): Promise<{ changes: PendingChange[] }> => impl.gitChanges(),
  commit: (message: string) => impl.commit(message),
  gitLog: (path: string, limit?: number): Promise<{ commits: FileCommit[] }> =>
    impl.gitLog(path, limit),
  gitDiff: (path: string, from: string | null, to: string) => impl.gitDiff(path, from, to),
  fileAtCommit: (path: string, sha: string) => impl.fileAtCommit(path, sha),
  push: () => impl.push(),
}

export { auth } from './server-backend.js'
export {
  BackendError,
  ConflictError,
  type FileSnapshot,
  type GitStatus,
  type Rev,
  type VaultBackend,
  type VaultEvent,
  type WriteResult,
} from './backend.js'
