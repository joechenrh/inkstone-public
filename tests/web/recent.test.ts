import { beforeEach, describe, expect, it } from 'vitest'
import type { VaultEntry } from '../../src/shared/types.js'
import { forgetRecent, pruneRecent, recentPaths, recordRecent } from '../../src/web/state/recent.js'

const file = (path: string): VaultEntry => ({ name: path.split('/').pop()!, path, type: 'file' })
const dir = (path: string, children: VaultEntry[]): VaultEntry =>
  ({ name: path.split('/').pop()!, path, type: 'dir', children })

beforeEach(() => {
  localStorage.clear()
  recentPaths.value = []
})

describe('recent notes', () => {
  it('puts the most recently opened first', () => {
    recordRecent('a.md')
    recordRecent('b.md')
    expect(recentPaths.value).toEqual(['b.md', 'a.md'])
  })

  it('moves a re-opened note to the front rather than duplicating it', () => {
    recordRecent('a.md')
    recordRecent('b.md')
    recordRecent('a.md')
    expect(recentPaths.value).toEqual(['a.md', 'b.md'])
  })

  it('keeps at most eight', () => {
    for (let i = 0; i < 12; i++) recordRecent(`n${i}.md`)
    expect(recentPaths.value).toHaveLength(8)
    expect(recentPaths.value[0]).toBe('n11.md')
  })

  it('survives a reload through localStorage', () => {
    recordRecent('notes/a.md')
    expect(JSON.parse(localStorage.getItem('inkstone.recent')!)).toEqual(['notes/a.md'])
  })

  it('drops entries whose file is no longer in the tree', () => {
    recordRecent('gone.md')
    recordRecent('notes/kept.md')
    pruneRecent([dir('notes', [file('notes/kept.md')])])
    expect(recentPaths.value).toEqual(['notes/kept.md'])
  })

  // The tree arrives after the list is read from storage; pruning against an empty tree would
  // wipe the history every time the app starts.
  it('does not prune against a tree that has not loaded yet', () => {
    recordRecent('a.md')
    pruneRecent([])
    expect(recentPaths.value).toEqual(['a.md'])
  })

  it('forgets a folder and everything under it', () => {
    recordRecent('notes/deep/a.md')
    recordRecent('notes/b.md')
    recordRecent('other.md')
    forgetRecent('notes')
    expect(recentPaths.value).toEqual(['other.md'])
  })
})
