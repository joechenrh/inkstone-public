import { describe, expect, it } from 'vitest'
import { diffForPath } from '../../../../src/web/api/github/tree.js'

/**
 * Pulling one file's hunks out of a commit's diff.
 *
 * The case that mattered is the quoted one. git quotes a path containing anything outside printable
 * ASCII and escapes the bytes in octal, so a note called `地址空间.md` arrives as
 * `"a/OS/\345\234\260..."`. Comparing that to the plain path never matched, the diff came back
 * empty, and History described every session of every non-Latin-named note as "No textual change" —
 * which in a vault written in Chinese is every note there is.
 */

const hunk = ['index 1..2 100644', '@@ -1 +1 @@', '-old', '+new'].join('\n')

describe('diffForPath', () => {
  it('finds a plain path', () => {
    const diff = `diff --git a/notes/a.md b/notes/a.md\n${hunk}`
    expect(diffForPath(diff, 'notes/a.md')).toContain('+new')
  })

  it('finds a path git had to quote and escape', () => {
    const quoted = '"a/OS/\\345\\234\\260\\345\\235\\200\\347\\251\\272\\351\\227\\264.md"'
    const quotedB = '"b/OS/\\345\\234\\260\\345\\235\\200\\347\\251\\272\\351\\227\\264.md"'
    const diff = `diff --git ${quoted} ${quotedB}\n${hunk}`
    expect(diffForPath(diff, 'OS/地址空间.md')).toContain('+new')
  })

  it('finds a path with a space in it', () => {
    const diff = `diff --git a/my notes/b.md b/my notes/b.md\n${hunk}`
    expect(diffForPath(diff, 'my notes/b.md')).toContain('+new')
  })

  it('picks the right file out of a commit that touched several', () => {
    const diff = [
      `diff --git a/other.md b/other.md\nindex 1..2 100644\n@@ -1 +1 @@\n-x\n+y`,
      `diff --git "a/\\344\\270\\255\\346\\226\\207.md" "b/\\344\\270\\255\\346\\226\\207.md"\n${hunk}`,
    ].join('\n')
    expect(diffForPath(diff, '中文.md')).toContain('+new')
    expect(diffForPath(diff, '中文.md')).not.toContain('+y')
    expect(diffForPath(diff, 'other.md')).toContain('+y')
  })

  it('says nothing for a file the commit did not touch', () => {
    const diff = `diff --git a/notes/a.md b/notes/a.md\n${hunk}`
    expect(diffForPath(diff, 'notes/never.md')).toBe('')
  })
})
