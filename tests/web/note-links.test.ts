import { beforeEach, describe, expect, it } from 'vitest'
import { headingSlug, headingSlugs, resolveLink, resolvePath } from '../../src/web/editor/note-links.js'
import { canGoBack, canGoForward, forgetVisits, recordVisit, stepBack, stepForward } from '../../src/web/state/visits.js'

/**
 * Where a link leads.
 *
 * The rules are GitHub's, deliberately: these notes are read on github.com as well as here, and a
 * link that works in one of the two places and not the other is worse than no link.
 */
describe('resolving a link', () => {
  const from = 'notes/deep/a.md'

  it('takes a bare or dotted path against the note itself', () => {
    expect(resolveLink('b.md', from)).toEqual({ kind: 'note', path: 'notes/deep/b.md', anchor: null })
    expect(resolveLink('./b.md', from)).toEqual({ kind: 'note', path: 'notes/deep/b.md', anchor: null })
    expect(resolveLink('../c.md', from)).toEqual({ kind: 'note', path: 'notes/c.md', anchor: null })
  })

  it('takes a leading slash against the vault root, like a picture', () => {
    expect(resolveLink('/notes/c.md', from)).toEqual({ kind: 'note', path: 'notes/c.md', anchor: null })
  })

  it('keeps the heading a link asks for', () => {
    expect(resolveLink('b.md#the-numbers', from))
      .toEqual({ kind: 'note', path: 'notes/deep/b.md', anchor: 'the-numbers' })
    expect(resolveLink('#the-numbers', from)).toEqual({ kind: 'anchor', anchor: 'the-numbers' })
  })

  it('decodes what a pasted URL escapes', () => {
    // GitHub writes links this way, and so does anything that copies one out of the address bar.
    expect(resolveLink('%E6%B5%8B%E8%AF%95.md', from))
      .toEqual({ kind: 'note', path: 'notes/deep/测试.md', anchor: null })
  })

  it('sends a picture to its own tab and an address to the browser', () => {
    expect(resolveLink('/assets/0123456789abcdef.webp', from))
      .toEqual({ kind: 'asset', path: 'assets/0123456789abcdef.webp' })
    expect(resolveLink('https://example.com', from)).toEqual({ kind: 'external', href: 'https://example.com' })
    expect(resolveLink('mailto:a@b.c', from)).toEqual({ kind: 'external', href: 'mailto:a@b.c' })
  })

  it('follows nothing else', () => {
    // A whitelist, and this is the reason for it.
    expect(resolveLink('javascript:alert(1)', from)).toBeNull()
    expect(resolveLink('file:///etc/passwd', from)).toBeNull()
    // In the vault but not something this application can open.
    expect(resolveLink('notes/paper.pdf', from)).toBeNull()
    expect(resolveLink('', from)).toBeNull()
  })

  it('refuses a path that climbs out of the vault rather than clamping it', () => {
    // Not a path that needed correcting — a link that means something this will not do.
    expect(resolveLink('../../../etc/passwd', from)).toBeNull()
    expect(resolvePath('../../..', from)).toBeNull()
  })

  it('resolves what it can with no note open', () => {
    expect(resolveLink('/notes/c.md', null)).toEqual({ kind: 'note', path: 'notes/c.md', anchor: null })
    // Relative to nothing is the vault root, which is the only reading left.
    expect(resolveLink('c.md', null)).toEqual({ kind: 'note', path: 'c.md', anchor: null })
  })
})

describe('heading anchors', () => {
  it('slugs the way github does', () => {
    expect(headingSlug('Heading one')).toBe('heading-one')
    expect(headingSlug('What it costs, stated plainly')).toBe('what-it-costs-stated-plainly')
    expect(headingSlug('Re-encoding, with the numbers')).toBe('re-encoding-with-the-numbers')
    expect(headingSlug('C++ and Rust')).toBe('c-and-rust')
  })

  it('keeps CJK, which is most of this vault', () => {
    expect(headingSlug('测试 文件')).toBe('测试-文件')
    expect(headingSlug('一、开头')).toBe('一开头')
  })

  it('numbers repeats, or the second one is unreachable', () => {
    expect(headingSlugs(['Notes', 'Body', 'Notes', 'Notes'])).toEqual(['notes', 'body', 'notes-1', 'notes-2'])
  })
})

/**
 * Back and forward.
 *
 * Following a link is otherwise a one-way door, and a dead end is a bug rather than a missing
 * button.
 */
describe('the notes visited this session', () => {
  beforeEach(() => { forgetVisits() })

  it('goes back to where you came from, and forward again', () => {
    recordVisit('a.md')
    expect(canGoBack.value).toBe(true)
    expect(stepBack('b.md')).toBe('a.md')
    expect(canGoBack.value).toBe(false)
    expect(canGoForward.value).toBe(true)
    expect(stepForward('a.md')).toBe('b.md')
  })

  it('does not collapse a return trip', () => {
    // a → b → a. Back belongs at b, which is where you just were.
    recordVisit('a.md')
    recordVisit('b.md')
    expect(stepBack('a.md')).toBe('b.md')
  })

  it('a new turning discards what was ahead', () => {
    recordVisit('a.md')
    stepBack('b.md')
    expect(canGoForward.value).toBe(true)
    recordVisit('a.md')
    expect(canGoForward.value).toBe(false)
  })

  it('has nowhere to go from a standing start', () => {
    expect(stepBack('a.md')).toBeNull()
    expect(stepForward('a.md')).toBeNull()
    expect(canGoBack.value).toBe(false)
  })
})
