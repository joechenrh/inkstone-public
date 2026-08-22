import { vi } from 'vitest'

/**
 * A stand-in for `api.github.com` that answers with the shapes the real one was measured to
 * return (see `docs/design/public-route.md`), so these tests fail when this app's reading of the
 * API is wrong rather than when GitHub is slow.
 *
 * It keeps a real branch: writing blobs, trees and commits moves `head`, so a test can assert
 * what a commit actually contained rather than only that one was attempted.
 */
export interface FakeRepo {
  /** Path → file text at the current head. Directories are implied, as a git tree implies them. */
  files: Record<string, string>
  truncated?: boolean
  commits?: Record<string, { sha: string; date: string; message: string }[]>
  diffs?: Record<string, string>
}

export interface FakeGitHub {
  fetch: typeof globalThis.fetch
  /** Every URL asked for, in order — the way to assert a cache prevented a request. */
  calls: string[]
  /** Requests that changed something, so a test can count commits rather than infer them. */
  writes: { url: string; body: unknown }[]
  /** The branch's current files, after whatever commits the test caused. */
  files(): Record<string, string>
  head(): string
  /** The message of a commit this fake accepted. */
  message(sha: string): string
  /** Moves the branch behind the app's back, which is the conflict this design has to survive. */
  moveBranch(): void
}

/** Deterministic stand-in for a blob sha: content-addressed, which is the property that matters. */
export function fakeSha(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(16).padStart(40, '0')
}

export function fakeGitHub(repo: FakeRepo): FakeGitHub {
  const calls: string[] = []
  const writes: { url: string; body: unknown }[] = []
  const bySha = new Map<string, string>()

  let files = { ...repo.files }
  let head = 'commit-0'
  let counter = 0
  /** Tree sha → the file map it describes, so a later commit can build on the right one. */
  const trees = new Map<string, Record<string, string>>()
  const commitTree = new Map<string, string>()
  const commitParent = new Map<string, string>()
  const commitMessage = new Map<string, string>()

  const remember = (map: Record<string, string>): string => {
    const sha = `tree-${++counter}`
    trees.set(sha, { ...map })
    for (const text of Object.values(map)) bySha.set(fakeSha(text), text)
    return sha
  }
  let headTree = remember(files)
  commitTree.set(head, headTree)

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const text = (body: string): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    const path = url.replace('https://api.github.com', '')
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(init.body as string)
    if (method !== 'GET') writes.push({ url: path, body })

    if (path.includes('/git/ref/heads/')) return json({ object: { sha: head } })

    if (method === 'PATCH' && path.includes('/git/refs/heads/')) {
      const wanted = (body as { sha: string }).sha
      const parent = commitParent.get(wanted)
      if (parent !== head) return json({ message: 'Update is not a fast forward' }, 422)
      head = wanted
      headTree = commitTree.get(wanted)!
      files = { ...trees.get(headTree)! }
      return json({ object: { sha: head } })
    }

    if (method === 'POST' && path.endsWith('/git/blobs')) {
      const content = (body as { content: string }).content
      const sha = fakeSha(content)
      bySha.set(sha, content)
      return json({ sha })
    }

    if (method === 'POST' && path.endsWith('/git/trees')) {
      const req = body as { base_tree: string; tree: { path: string; sha: string | null }[] }
      const next = { ...(trees.get(req.base_tree) ?? {}) }
      for (const entry of req.tree) {
        if (entry.sha === null) delete next[entry.path]
        else next[entry.path] = bySha.get(entry.sha) ?? ''
      }
      return json({ sha: remember(next) })
    }

    if (method === 'POST' && path.endsWith('/git/commits')) {
      const req = body as { tree: string; parents: string[]; message: string }
      const sha = `commit-${++counter}`
      commitTree.set(sha, req.tree)
      commitParent.set(sha, req.parents[0] ?? '')
      commitMessage.set(sha, req.message)
      return json({ sha })
    }

    const tree = /\/git\/trees\/([^?]+)\?recursive=1/.exec(path)
    if (tree) {
      const map = trees.get(commitTree.get(decodeURIComponent(tree[1]!)) ?? '') ?? files
      const dirs = new Set<string>()
      for (const file of Object.keys(map)) {
        const parts = file.split('/')
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
      }
      return json({
        sha: commitTree.get(decodeURIComponent(tree[1]!)) ?? headTree,
        truncated: repo.truncated ?? false,
        tree: [
          ...[...dirs].map((d) => ({ path: d, type: 'tree', sha: `tree-${d}` })),
          ...Object.entries(map).map(([p, content]) => ({
            path: p,
            type: 'blob',
            sha: fakeSha(content),
            size: new TextEncoder().encode(content).length,
          })),
        ],
      })
    }

    const blob = /\/git\/blobs\/([0-9a-f-]+)$/.exec(path)
    if (blob) {
      const found = bySha.get(blob[1]!)
      if (found === undefined) return json({ message: 'Not Found' }, 404)
      // GitHub answers a blob two ways, and which one you get is the accept header: raw bytes for
      // `application/vnd.github.raw`, otherwise JSON with the content base64-encoded. Notes take
      // the first and pictures the second, so the fake has to know the difference too.
      const accept = String((init?.headers as Record<string, string> | undefined)?.accept ?? '')
      return accept.includes('raw') ? text(found) : json({ content: found, encoding: 'base64' })
    }

    const contents = /\/contents\/(.+)\?ref=/.exec(path)
    if (contents) {
      const found = files[decodeURIComponent(contents[1]!)]
      return found === undefined ? json({ message: 'Not Found' }, 404) : text(found)
    }

    if (path.includes('/commits?')) {
      const wanted = decodeURIComponent(/[?&]path=([^&]*)/.exec(path)?.[1] ?? '')
      return json((repo.commits?.[wanted] ?? []).map((c) => ({
        sha: c.sha,
        commit: { message: c.message, author: { date: c.date }, committer: { date: c.date } },
      })))
    }

    if (path.includes('/compare/') || /\/commits\/[0-9a-z-]+$/.test(path)) {
      const key = path.slice(path.lastIndexOf('/') + 1)
      return text(repo.diffs?.[key] ?? '')
    }

    return json({ message: `fake github has no route for ${method} ${path}` }, 404)
  })

  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    writes,
    files: () => ({ ...files }),
    head: () => head,
    message: (sha: string) => commitMessage.get(sha) ?? '',
    moveBranch: () => {
      const next = { ...files, 'someone-else.md': 'written elsewhere' }
      headTree = remember(next)
      head = `commit-${++counter}`
      commitTree.set(head, headTree)
      files = next
    },
  }
}
