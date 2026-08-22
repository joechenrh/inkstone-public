import { describe, expect, it } from 'vitest'
import { diffText, diffWholeFile } from '../../../../src/web/api/github/diff.js'

describe('diffText', () => {
  it('is empty when nothing changed', () => {
    expect(diffText('same\n', 'same\n')).toEqual({ text: '', added: 0, removed: 0 })
  })

  it('shows one changed line with context either side', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g'].join('\n')
    const { text, added, removed } = diffText(before, after)
    expect(added).toBe(1)
    expect(removed).toBe(1)
    expect(text).toBe([
      '@@ -1,7 +1,7 @@',
      ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g',
    ].join('\n'))
  })

  it('leaves untouched distance out of the hunk', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 10', 'line TEN')
    const { text } = diffText(before, after)
    expect(text).toBe([
      '@@ -8,7 +8,7 @@',
      ' line 7', ' line 8', ' line 9', '-line 10', '+line TEN', ' line 11', ' line 12', ' line 13',
    ].join('\n'))
  })

  it('emits a hunk per island of change rather than one that swallows the file', () => {
    const before = Array.from({ length: 40 }, (_, i) => `${i}`).join('\n')
    const after = before.replace('\n5\n', '\n五\n').replace('\n30\n', '\n三十\n')
    const { text } = diffText(before, after)
    expect(text.match(/^@@ /gm)).toHaveLength(2)
  })

  it('counts a pure insertion, and gives the old side a zero range', () => {
    const { text, added, removed } = diffText('', 'first\nsecond\n')
    expect({ added, removed }).toEqual({ added: 2, removed: 0 })
    expect(text).toBe('@@ -0,0 +1,2 @@\n+first\n+second')
  })

  it('handles CJK lines, which are one line each like any other', () => {
    const { text, added, removed } = diffText('第一行\n第二行\n', '第一行\n改过的第二行\n')
    expect({ added, removed }).toEqual({ added: 1, removed: 1 })
    expect(text).toContain('-第二行')
    expect(text).toContain('+改过的第二行')
  })

  it('does not turn a trailing newline into an extra empty line', () => {
    expect(diffText('one\n', 'one\ntwo\n').text).toBe('@@ -1 +1,2 @@\n one\n+two')
  })

  it('finds the small edit inside a large file without walking the whole thing', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 2000', 'line two thousand')
    const started = performance.now()
    const { text, added, removed } = diffText(before, after)
    expect({ added, removed }).toEqual({ added: 1, removed: 1 })
    expect(text.match(/^@@ /gm)).toHaveLength(1)
    // Prefix/suffix trimming is what makes this cheap; without it this is minutes, not milliseconds.
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('reports two files with nothing in common as replaced, rather than grinding', () => {
    const before = Array.from({ length: 5000 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join('\n')
    const { added, removed } = diffText(before, after)
    expect({ added, removed }).toEqual({ added: 5000, removed: 5000 })
  })
})

describe('diffWholeFile', () => {
  it('renders a new file as every line added', () => {
    expect(diffWholeFile('a\nb\n', 'added')).toEqual({
      text: '@@ -0,0 +1,2 @@\n+a\n+b',
      added: 2,
      removed: 0,
    })
  })

  it('renders a deleted file as every line removed', () => {
    expect(diffWholeFile('a\nb\n', 'deleted')).toEqual({
      text: '@@ -1,2 +0,0 @@\n-a\n-b',
      added: 0,
      removed: 2,
    })
  })
})
