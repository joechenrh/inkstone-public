import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import type { FileCommit, PendingChange } from '../../shared/types.js'

export type { FileCommit, PendingChange }

/**
 * Drop git's file header from a diff.
 *
 * `diff --git`, `index`, `---` and `+++` say what is already in the row above the diff, and git
 * writes non-ASCII paths in them octal-escaped — a note called 测试文件.md arrives as
 * `"a/\346\265\213..."`, which is unreadable and is the first thing you see. The `@@` hunk
 * markers stay: they say where in the file you are, which the header does not.
 */
function stripDiffHeader(diff: string): string {
  const lines = diff.split('\n')
  const start = lines.findIndex((line) => line.startsWith('@@'))
  if (start !== -1) return lines.slice(start).join('\n')
  // No hunk header at all — an untracked file's synthesised diff, or an empty one.
  return lines
    .filter((line) => !/^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (from|to) )/.test(line))
    .join('\n')
}

export class VaultGitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultGitError'
  }
}

export interface RemoteInfo {
  name: string
  branch: string
  ahead: number
}

export interface GitStatus {
  dirty: boolean
  branch: string
}

export interface CommitResult {
  sha: string
  files: string[]
}

// The well-known SHA-1 of git's empty tree object — identical in every repo.
// Diffing a root commit (which has no parent) against this gives the same
// "everything in this commit is new" diff `git show` produces, instead of
// letting `${sha}^` fail to resolve.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// Files git leaves behind in the git directory while an operation that
// touches the working tree is unfinished. Their presence means the working
// tree may hold half-applied changes (conflict markers, a merge in
// progress, ...) that must never be swept into an autosave commit.
const IN_PROGRESS_MARKERS = ['REVERT_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']

/**
 * The single point every simple-git call in this module goes through.
 * simple-git's error text is third-party and out of our control — exactly
 * like Node's fs errno strings, which is why Vault's guardFs has the same
 * shape. Wrapping unconditionally (not just for the cases known today to
 * leak a path) means a future simple-git version can change its message
 * text without a raw GitError ever escaping this module.
 */
async function guardGit<T>(op: () => Promise<T>, message: string): Promise<T> {
  try {
    return await op()
  } catch (err) {
    if (err instanceof VaultGitError) throw err
    throw new VaultGitError(message, { cause: err })
  }
}

export class VaultGit {
  // Lazily constructed rather than built in the constructor: simple-git's
  // factory synchronously throws GitConstructError when `root` does not
  // exist on disk. Eagerly calling simpleGit(root) here would let that raw,
  // unwrapped error escape from `new VaultGit(...)` itself, before any
  // guardGit try/catch is in scope to translate it — breaking the "every
  // method rejects VaultGitError, never a raw third-party error" invariant
  // for exactly the callers most likely to hit it (a caller probing whether
  // a path is usable at all). Deferring construction into #getGit(), called
  // from inside each method's own try/catch (guardGit's, or revertCommit's),
  // routes that failure through the same wrapping as every other git error.
  #git: SimpleGit | undefined

  constructor(readonly root: string) {}

  #getGit(): SimpleGit {
    this.#git ??= simpleGit(this.root)
    return this.#git
  }

  async isRepo(): Promise<boolean> {
    try {
      return await this.#getGit().checkIsRepo()
    } catch {
      return false
    }
  }

  async status(): Promise<GitStatus> {
    const s = await guardGit(() => this.#getGit().status(), 'git status failed')
    return { dirty: !s.isClean(), branch: s.current ?? 'HEAD' }
  }

  /**
   * What is uncommitted, with a diff for each file.
   *
   * `diffFileRange` answers "what changed between two commits"; nothing answered "what is about to
   * be committed", which is the one question the Commit button could not answer before pressing it.
   *
   * Diffed against HEAD with `--` per file rather than in one call, so a rename or an unreadable
   * path costs that file's diff rather than the whole answer. Untracked files have no HEAD side, so
   * their contents are read as an all-added diff — otherwise a brand new note shows as a name with
   * nothing behind it, which is exactly when you most want to look.
   */
  async pendingChanges(): Promise<PendingChange[]> {
    const s = await guardGit(() => this.#getGit().status(), 'git status failed')
    const git = this.#getGit()

    const paths = new Set<string>([
      ...s.not_added, ...s.created, ...s.modified, ...s.deleted, ...s.renamed.map((r) => r.to),
    ])

    const out: PendingChange[] = []
    for (const filePath of paths) {
      let diff = ''
      let status: PendingChange['status'] = 'modified'

      if (s.not_added.includes(filePath) || s.created.includes(filePath)) {
        status = 'added'
        try {
          // An untracked file has no committed side to diff against.
          const text = await fs.readFile(path.join(this.root, filePath), 'utf8')
          diff = text.split('\n').map((line) => `+${line}`).join('\n')
        } catch { diff = '' }
      } else if (s.deleted.includes(filePath)) {
        status = 'deleted'
        diff = await guardGit(() => git.diff(['HEAD', '--', filePath]), 'git diff failed').catch(() => '')
      } else {
        diff = await guardGit(() => git.diff(['HEAD', '--', filePath]), 'git diff failed').catch(() => '')
      }

      diff = stripDiffHeader(diff)

      let added = 0
      let removed = 0
      for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++
        else if (line.startsWith('-') && !line.startsWith('---')) removed++
      }
      out.push({ path: filePath, status, added, removed, diff })
    }

    out.sort((a, b) => a.path.localeCompare(b.path))
    return out
  }

  // add(['-A']) and commit() both write .git/index (and, for commit, refs).
  // Unlike status()/diff(), which are read-only, a concurrent git process
  // holding .git/index.lock makes these fail with a message that embeds the
  // repo's absolute path (e.g. "Unable to create '/abs/vault/.git/index.lock'").
  // guardGit strips that down to a path-free message; the raw error is kept
  // as `cause` for operators.
  /**
   * Stages all changes and returns the list of files that will be committed
   * (an empty array means nothing to commit).
   *
   * The in-progress revert/merge/cherry-pick check (see
   * #assertNoInProgressOperation) is also run here rather than relying on the
   * convention "callers always call stageAll first": the caller may be
   * commitAll or an AutoCommit (Task 8) stageAll+commitStaged pair. The check
   * itself is cheap (one rev-parse plus a few fs.access calls); the benefit is
   * that no call path can bypass it.
   */
  async stageAll(): Promise<string[]> {
    await this.#assertNoInProgressOperation()

    await guardGit(() => this.#getGit().add(['-A']), 'git add failed')
    const staged = await guardGit(() => this.#getGit().status(), 'git status failed')
    return [...staged.staged, ...staged.renamed.map((r) => r.to)].sort()
  }

  /**
   * Commits the already-staged content. The caller must have called stageAll
   * first and confirmed the list is non-empty.
   *
   * Fix round 1 / Finding 1: the in-progress revert/merge/cherry-pick check is
   * *also* repeated here rather than relying solely on the doc-comment
   * convention above. stageAll's check only protects callers that go through
   * stageAll — if commitStaged is called directly (now or via a future call
   * path), the only guard before this check was a comment, and comments cannot
   * block code. The cost of two checks is one extra rev-parse + a few
   * fs.access calls (commits run at most once every few minutes, not a hot
   * path); the benefit is that "commit conflict markers into history" no longer
   * depends on every caller remembering to follow the convention.
   */
  async commitStaged(message: string): Promise<string> {
    await this.#assertNoInProgressOperation()

    await guardGit(() => this.#getGit().commit(message), 'git commit failed')
    return guardGit(() => this.#getGit().revparse(['HEAD']), 'git rev-parse failed')
  }

  async #assertNoInProgressOperation(): Promise<void> {
    const marker = await this.#inProgressMarker()
    if (marker !== null) {
      // A revert/merge/cherry-pick left mid-flight — by revertCommit's own
      // failed abort (see below), or by something outside this process
      // entirely (the user's terminal, a crashed run). Either way the
      // working tree may hold conflict markers; committing it would bake
      // corrupted content into the vault's history under an autosave loop.
      // null would read as "nothing to commit" and hide exactly that, so
      // this must throw instead.
      throw new VaultGitError(
        `repository has an unfinished git operation in progress (${marker} present); refusing to commit`,
      )
    }
  }

  async commitAll(message: string): Promise<CommitResult | null> {
    const files = await this.stageAll()
    if (files.length === 0) return null

    const sha = await this.commitStaged(message)
    return { sha, files }
  }

  async remoteInfo(): Promise<RemoteInfo | null> {
    return guardGit(async () => {
      const remotes = await this.#getGit().getRemotes()
      if (remotes.length === 0) return null
      const status = await this.#getGit().status()
      const branch = status.current ?? 'HEAD'
      if (!status.tracking) return null // no upstream
      const name = status.tracking.split('/')[0] ?? remotes[0]!.name
      const raw = await this.#getGit().raw(['rev-list', '--count', '@{u}..HEAD'])
      return { name, branch, ahead: Number.parseInt(raw.trim(), 10) || 0 }
    }, 'git remote info failed')
  }

  async push(): Promise<{ pushed: number }> {
    const info = await this.remoteInfo()
    if (info === null) {
      throw new VaultGitError('no upstream configured for the current branch')
    }
    try {
      await this.#getGit().push()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/non-fast-forward|rejected|fetch first|behind/i.test(msg)) {
        throw new VaultGitError('remote has changes; pull before pushing', { cause: err })
      }
      if (/authenticat|permission|could not read|access denied/i.test(msg)) {
        throw new VaultGitError('authentication failed while pushing', { cause: err })
      }
      throw new VaultGitError('push failed', { cause: err })
    }
    return { pushed: info.ahead }
  }

  async diffOfCommit(sha: string): Promise<string> {
    const base = (await this.#hasParent(sha)) ? `${sha}^` : EMPTY_TREE_SHA
    return guardGit(() => this.#getGit().diff([base, sha]), `diff of commit ${sha} failed`)
  }

  // revert writes .git/index and, on conflict, the working tree itself. A
  // conflicting revert leaves both mid-operation: REVERT_HEAD set, conflict
  // markers written into the caller's files. This module sits under an
  // autosave loop (commitAll), so leaving that state behind means the very
  // next autosave commits corrupted notes — the safety net causing the data
  // loss it exists to prevent. On any revert failure we must therefore
  // always attempt `revert --abort` before rethrowing, and the two outcomes
  // are reported with distinguishable messages so a caller can tell "nothing
  // changed" from "the repo is now in a bad state":
  //   - abort succeeds: the conflict is undone, working tree and REVERT_HEAD
  //     are back to how they were before this call — safe to report as a
  //     plain, contained failure.
  //   - abort itself fails: we cannot verify the repository's state. Rather
  //     than silently swallow that (worse than reporting it), we say
  //     explicitly that manual attention is needed, even though this errs on
  //     the side of over-reporting: e.g. a bad-sha revert that never started
  //     anything will also hit this branch, since there is nothing for
  //     `--abort` to abort (probed empirically — abort then fails with
  //     "no cherry-pick or revert in progress", not a lock/path error).
  async revertCommit(sha: string): Promise<void> {
    try {
      await this.#getGit().raw(['revert', '--no-edit', sha])
    } catch (err) {
      try {
        await this.#getGit().raw(['revert', '--abort'])
      } catch (abortErr) {
        throw new VaultGitError(
          `revert of commit ${sha} failed and the repository was left in a mid-revert state; manual attention required`,
          { cause: abortErr },
        )
      }
      throw new VaultGitError(
        `revert of commit ${sha} could not complete due to a conflict; the repository was restored and no changes were made`,
        { cause: err },
      )
    }
  }

  /**
   * Commits that touched one file, newest first.
   *
   * Parsed from raw `git log` rather than simple-git's `log()` because the per-commit line counts
   * come from `--numstat`, which its typed result does not carry. The separators are written as
   * git's own `%x01` / `%x00` escapes rather than literal control bytes in the argument — git does
   * not expand a raw \x01 in a format string, and passing one makes the whole call fail. Those two
   * bytes cannot occur in a path, a date, or a subject.
   */
  async logForFile(filePath: string, limit: number): Promise<FileCommit[]> {
    const raw = await guardGit(
      () => this.#getGit().raw([
        'log', `--max-count=${limit}`, '--numstat', '--format=%x01%H%x00%aI%x00%s', '--', filePath,
      ]),
      `log for ${filePath} failed`,
    )

    const out: FileCommit[] = []
    for (const record of raw.split('\x01')) {
      if (!record.trim()) continue
      const [header = '', ...rest] = record.split('\n')
      const [sha, date, message] = header.split('\x00')
      if (!sha || !date) continue
      let added = 0
      let removed = 0
      for (const line of rest) {
        const cols = line.split('\t')
        if (cols.length < 3) continue
        // "-" in place of a count means a binary file; nothing useful to add up.
        added += Number.parseInt(cols[0] ?? '', 10) || 0
        removed += Number.parseInt(cols[1] ?? '', 10) || 0
      }
      out.push({ sha, date, message: message ?? '', added, removed })
    }
    return out
  }

  /**
   * The diff for one file across a range of commits — what a whole writing session changed, rather
   * than what each five-minute autosave inside it did.
   *
   * `fromSha` is the commit *before* the range. Null means the range reaches back to the file's
   * first appearance, so the empty tree stands in as the base.
   */
  async diffFileRange(fromSha: string | null, toSha: string, filePath: string): Promise<string> {
    const base = fromSha ?? EMPTY_TREE_SHA
    return guardGit(
      () => this.#getGit().diff([base, toSha, '--', filePath]),
      `diff of ${filePath} between ${base} and ${toSha} failed`,
    )
  }

  /**
   * A file's content as of one commit.
   *
   * This is what "restore this version" is built on, deliberately instead of `revertCommit`: revert
   * is repo-wide, writes a new commit, and can conflict — and an autosave commit usually touches
   * several notes, so reverting one would rewrite notes the reader was not even looking at. Reading
   * the old content and letting the editor treat it as unsaved text changes nothing until the user
   * saves, and goes through the ordinary save path when they do.
   */
  async fileAtCommit(sha: string, filePath: string): Promise<string> {
    return guardGit(
      () => this.#getGit().show([`${sha}:${filePath}`]),
      `reading ${filePath} at ${sha} failed`,
    )
  }

  async #hasParent(sha: string): Promise<boolean> {
    const out = await guardGit(
      () => this.#getGit().raw(['rev-list', '--parents', '-n', '1', sha]),
      `could not resolve commit ${sha}`,
    )
    return out.trim().split(/\s+/).length > 1
  }

  async #gitDir(): Promise<string> {
    const out = await guardGit(
      () => this.#getGit().raw(['rev-parse', '--absolute-git-dir']),
      'could not resolve git directory',
    )
    return out.trim()
  }

  async #inProgressMarker(): Promise<string | null> {
    const dir = await this.#gitDir()
    for (const marker of IN_PROGRESS_MARKERS) {
      try {
        await fs.access(path.join(dir, marker))
        return marker
      } catch {
        // marker absent, keep checking
      }
    }
    return null
  }
}
