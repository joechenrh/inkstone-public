import { signal } from '@preact/signals'
import type { SearchMatch, VaultEntry } from '../../shared/types.js'
import { backend } from '../api/index.js'
import { documentRoot } from '../editor/surface.js'

/**
 * Search, done in the browser.
 *
 * It used to ask the server on every keystroke, and that is why it felt slow: a debounce to avoid
 * flooding a remote machine, a request that could be overtaken by the next one, a "Searching…"
 * state that emptied the list it was about to refill, and a two-character minimum invented to keep
 * the cost down — which is why "1" found nothing and "11" found something.
 *
 * VS Code and Typora do not feel like that because they search local data. So does this now. The
 * vault's text is fetched **once** and searched in memory: no request per keystroke, nothing to be
 * stale, no debounce, no minimum, and no flashing. Measured on the real vault: 2,271 bytes, 1,220
 * gzipped — a hundred times that is still a rounding error next to the editor bundle.
 */
export const searchQuery = signal('')

interface Note { path: string; text: string }

/** null until the first search needs it. */
let corpus: Note[] | null = null
let loading: Promise<void> | null = null

export const corpusLoading = signal(false)
export const corpusTruncated = signal(false)

/**
 * Thrown away whenever the vault changes, and reloaded the next time someone searches.
 *
 * Cheap because it is one request for a small payload, and correct because the alternative —
 * patching the copy on every save — is a second source of truth to keep in step.
 */
export function invalidateCorpus(): void {
  corpus = null
  loading = null
}

async function ensureCorpus(): Promise<void> {
  if (corpus !== null) return
  if (loading === null) {
    corpusLoading.value = true
    loading = backend.corpus()
      .then(({ notes, truncated }) => {
        corpus = notes
        corpusTruncated.value = truncated
      })
      .catch(() => { corpus = []; })
      .finally(() => { corpusLoading.value = false })
  }
  await loading
}

export function setSearchQuery(q: string): void {
  searchQuery.value = q
  // Load on the first character typed; every keystroke after that is answered from memory.
  if (q.trim() !== '') void ensureCorpus().then(() => { corpusVersion.value++ })
}

/**
 * How many notes mention `name` — the filename of a picture.
 *
 * Matched on the name rather than on the whole path because a note may spell the reference either
 * way (`/assets/x.webp` or `assets/x.webp`), and the name is the hash of the bytes, so it is not a
 * word that turns up by accident.
 *
 * The corpus is the copy the search already keeps; this is the first thing other than search to ask
 * it a question, which is the argument for it being a copy at all.
 */
export async function notesUsing(name: string): Promise<number> {
  await ensureCorpus()
  if (corpus === null) return 0
  return corpus.filter((note) => note.text.includes(name)).length
}

/** Bumped when the corpus arrives, so a search typed before it landed re-runs against it. */
export const corpusVersion = signal(0)

export function clearSearch(): void {
  searchQuery.value = ''
}

/**
 * Every note whose text contains the query, with the line it is on.
 *
 * Literal and case-insensitive, not a regex: the query is whatever was typed, and `co_await(` is a
 * reasonable thing to look for and an invalid pattern. One hit per note — the list is a way back
 * into a note, not a concordance.
 */
export function matchingText(query: string): SearchMatch[] {
  const needle = query.trim().toLowerCase()
  if (needle === '' || corpus === null) return []

  const out: SearchMatch[] = []
  for (const note of corpus) {
    const at = note.text.toLowerCase().indexOf(needle)
    if (at === -1) continue

    const lineStart = note.text.lastIndexOf('\n', at) + 1
    const lineEnd = note.text.indexOf('\n', at)
    const line = note.text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    const inLine = at - lineStart
    // Only a few characters of lead: the row is one clipped line in a 250px panel, so anything in
    // front of the match competes with the match for the space that is visible.
    const from = Math.max(0, inLine - 12)
    const to = Math.min(line.length, inLine + needle.length + 120)
    out.push({
      path: note.path,
      line: note.text.slice(0, at).split('\n').length,
      text: (from > 0 ? '…' : '') + line.slice(from, to).trim() + (to < line.length ? '…' : ''),
    })
  }
  return out
}

/**
 * Every note whose *name* contains the query, flattened.
 *
 * Flat rather than a pruned tree: the text results below it are a flat list, and two shapes of
 * answer to one question is a shape more than the question has.
 */
export function matchingNames(entries: VaultEntry[], query: string): VaultEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []

  const out: VaultEntry[] = []
  const walk = (list: VaultEntry[]): void => {
    for (const entry of list) {
      if (entry.type === 'dir') { walk(entry.children ?? []); continue }
      if (entry.name.toLowerCase().includes(needle)) out.push(entry)
    }
  }
  walk(entries)
  return out
}

/**
 * Open a note and go to the match.
 *
 * The line number cannot be used directly — the rendered document has nodes, not lines — so the
 * text is the anchor. The match is *selected* rather than marked up: an element put there would be
 * inside the editable surface, where it becomes part of the document and is written to the file.
 */
export async function openAtMatch(
  path: string,
  query: string,
  open: (p: string) => Promise<void>,
): Promise<void> {
  await open(path)
  const needle = query.trim()
  if (needle === '') return

  // Polled rather than delayed: how long the render takes depends on the size of the note. Gives
  // up rather than spinning when the match is inside markdown the renderer eats.
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((r) => { setTimeout(r, 50) })
    if (revealFirstMatch(needle)) return
  }
}

function revealFirstMatch(needle: string): boolean {
  const root = documentRoot()
  if (!root) return false

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const lower = needle.toLowerCase()
  let node: Node | null
  while ((node = walker.nextNode()) !== null) {
    const text = node.nodeValue ?? ''
    const at = text.toLowerCase().indexOf(lower)
    if (at === -1) continue

    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + needle.length)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    ;(node.parentElement ?? root).scrollIntoView({ block: 'center' })
    return true
  }
  return false
}
