/**
 * What a link in a note points at.
 *
 * One resolver, and no editor knows about it — the lesson the pictures taught twice: where a path
 * leads is a fact about the vault, not about whichever engine drew the underline.
 *
 * **Resolution is GitHub's**, deliberately. These notes are read on github.com as well as here, so
 * a path with no leading slash resolves against the note's own directory and one with a leading
 * slash against the repository root. A link that works in one of the two places and not the other
 * is worse than no link at all.
 */

import { offerNotice, type Point } from '../assets/inbox.js'
import { blockText, documentRoot } from './surface.js'

/** Only what a note may legitimately point at. `javascript:` and `file:` are not links. */
const EXTERNAL = /^(https?|mailto):/i

/** The directory a picture lives in, matching the vault route and the GitHub one. */
const ASSET_DIR = 'assets'

export type LinkTarget =
  /** Another note, and optionally a heading in it. */
  | { kind: 'note'; path: string; anchor: string | null }
  /** A heading in the note that is already open. */
  | { kind: 'anchor'; anchor: string }
  /** A picture, which opens in a tab of its own. */
  | { kind: 'asset'; path: string }
  | { kind: 'external'; href: string }

/**
 * Where `href` leads, read from a note at `from`, or null when it leads nowhere this app follows.
 *
 * `from` is the open note's path; null means no note is open, in which case only the absolute and
 * external forms can be resolved.
 */
export function resolveLink(href: string, from: string | null): LinkTarget | null {
  const raw = href.trim()
  if (raw === '') return null
  if (EXTERNAL.test(raw)) return { kind: 'external', href: raw }
  // A scheme this application does not follow — including `javascript:`, which is the reason this
  // is a whitelist and not a blacklist.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null

  const hash = raw.indexOf('#')
  const path = hash < 0 ? raw : raw.slice(0, hash)
  const anchor = hash < 0 ? null : decode(raw.slice(hash + 1))

  if (path === '') return anchor === null || anchor === '' ? null : { kind: 'anchor', anchor }

  const resolved = resolvePath(decode(path), from)
  if (resolved === null) return null
  if (resolved === `${ASSET_DIR}` || resolved.startsWith(`${ASSET_DIR}/`)) {
    return { kind: 'asset', path: resolved }
  }
  // Anything else in the vault is a note only if it is one. A link to a `.pdf` sitting in the
  // repository is not something this application can open, and pretending otherwise would put a
  // note on screen that is not a note.
  if (!/\.mdx?$/i.test(resolved)) return null
  return { kind: 'note', path: resolved, anchor: anchor === '' ? null : anchor }
}

/**
 * A vault path from a link, or null if it climbs out of the vault.
 *
 * Refused rather than clamped: `../../etc/passwd` is not a note whose path needed correcting, it is
 * a link that means something this application will not do.
 */
export function resolvePath(path: string, from: string | null): string | null {
  const absolute = path.startsWith('/')
  const base = absolute || from === null ? [] : from.split('/').slice(0, -1)
  const parts = absolute ? path.slice(1).split('/') : path.split('/')

  const out = [...base]
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.length === 0 ? null : out.join('/')
}

/** `%E6%B5%8B%E8%AF%95.md` → `测试.md`. GitHub writes links that way, and so does a pasted URL. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // A stray `%` is a character, not an escape.
    return value
  }
}

/**
 * A heading's anchor, by GitHub's rules.
 *
 * Lowercased, punctuation dropped, spaces to hyphens, everything else — CJK included — kept as it
 * is. Not read from the DOM `id`: this application's other engine derives those from the heading
 * text and rewrites them on every edit, which is exactly why the outline holds element references
 * rather than ids.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    // Keep letters, numbers, spaces, `-` and `_`; drop the rest. Expressed as what survives rather
    // than as a list of punctuation, which is how CJK punctuation was missed the first time —
    // `一、开头` kept its `、` because the range written out covered U+2000 and not U+3000.
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/**
 * The same, for a list of headings in document order, with GitHub's duplicate suffixes.
 *
 * Two headings called "Notes" are `#notes` and `#notes-1`, and the second one is unreachable
 * without this.
 */
export function headingSlugs(texts: string[]): string[] {
  const seen = new Map<string, number>()
  return texts.map((text) => {
    const base = headingSlug(text)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}-${n}`
  })
}

/**
 * Follow a link, whichever engine drew it.
 *
 * Returns false when the href is not one this application follows, which is the signal to let the
 * event alone. Everything it *does* follow it also reports on failure: silence is what the previous
 * version did and it is indistinguishable from a broken gesture.
 */
export function followLink(href: string, from: string | null, at: Point | null = null): boolean {
  const target = resolveLink(href, from)
  if (target === null) return false

  switch (target.kind) {
    case 'external':
      window.open(target.href, '_blank', 'noopener,noreferrer')
      return true
    case 'anchor':
      scrollToHeading(target.anchor, at)
      return true
    case 'asset':
      void openAsset(target.path, at)
      return true
    case 'note':
      void openNote(target.path, target.anchor, at)
      return true
  }
}

async function openNote(path: string, anchor: string | null, at: Point | null = null): Promise<void> {
  const { openFile } = await import('../state/document.js')
  const { treeHas } = await import('../state/vault.js')
  if (!treeHas(path)) {
    offerNotice('no such note', path, at)
    return
  }
  await openFile(path)
  if (anchor !== null) {
    // After the document has been laid out: the note has only just arrived, and one frame is not
    // enough for an engine that renders asynchronously.
    window.setTimeout(() => { scrollToHeading(anchor) }, 120)
  }
}

async function openAsset(path: string, at: Point | null = null): Promise<void> {
  const { backend } = await import('../api/index.js')
  const url = await backend.assetUrl(path)
  if (url === null) {
    offerNotice('no such picture', path, at)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Scroll to the heading whose slug matches, and say so when there is none. */
export function scrollToHeading(anchor: string, from: Point | null = null): void {
  const root = documentRoot()
  if (root === null) return
  const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
  const slugs = headingSlugs(headings.map((h) => blockText(h)))
  const at = slugs.indexOf(anchor.toLowerCase())
  if (at < 0) {
    offerNotice('no such heading', anchor, from)
    return
  }
  headings[at]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
