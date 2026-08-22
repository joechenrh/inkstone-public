import { render } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import type { VaultEntry } from '../../src/shared/types.js'
import { EmptyState } from '../../src/web/editor/EmptyState.js'
import { recentPaths } from '../../src/web/state/recent.js'
import { tree } from '../../src/web/state/vault.js'

const file = (path: string): VaultEntry => ({ name: path, path, type: 'file' })

const texts = (root: Element, sel: string) =>
  Array.from(root.querySelectorAll(sel), (el) => el.textContent)

beforeEach(() => {
  localStorage.clear()
  recentPaths.value = []
  tree.value = []
})

describe('EmptyState', () => {
  // The actions do not depend on having a history, so Start is unconditional. Recent is not:
  // a heading over an empty list is worse than no list.
  it('offers the actions with no history, and no Recent heading over nothing', () => {
    const { container } = render(<EmptyState />)
    expect(texts(container, '.ink-empty-eyebrow')).toEqual(['Start'])
    expect(texts(container, '.ink-empty-action .ink-empty-name')).toEqual(['New note', 'New folder'])
    expect(container.querySelector('.ink-empty-recent .ink-empty-item:not(.ink-empty-action)')).toBeNull()
  })

  // Only when there is nothing on the left to pick either — with a full sidebar, "this vault is
  // empty" is simply false.
  it('says the vault is empty only when it is', () => {
    expect(render(<EmptyState />).container.querySelector('.ink-empty-line')?.textContent)
      .toBe('This vault is empty.')

    tree.value = [file('a.md')]
    expect(render(<EmptyState />).container.querySelector('.ink-empty-line')).toBeNull()
  })

  it('lists the history most recent first, with the folder each note lives in', () => {
    tree.value = [file('a.md')]
    recentPaths.value = ['notes/deep/b.md', 'a.md']
    const { container } = render(<EmptyState />)
    expect(texts(container, '.ink-empty-eyebrow')).toEqual(['Recent', 'Start'])
    // The action rows share the row markup, so the recent names are the ones before them.
    expect(texts(container, '.ink-empty-name').slice(0, 2)).toEqual(['b.md', 'a.md'])
    expect(texts(container, '.ink-empty-where').slice(0, 2)).toEqual(['notes / deep', 'Vault root'])
  })

  // A keycap naming a key that does nothing is worse than no keycap: every chip here is a
  // shortcut `handleShortcut` implements.
  it('advertises the create shortcuts on the action rows', () => {
    const { container } = render(<EmptyState />)
    const keys = Array.from(container.querySelectorAll('.ink-empty-action'), (row) =>
      Array.from(row.querySelectorAll('kbd'), (k) => k.textContent).join(''))
    // jsdom reports a non-Mac user agent, so the chips read Ctrl/Alt rather than ⌘⌥.
    expect(keys).toEqual(['CtrlAltN', 'CtrlAltF'])
  })

  it('signs the page with the wordmark', () => {
    const { container } = render(<EmptyState />)
    expect(container.querySelector('.ink-empty-mark')?.textContent).toBe('Inkstone')
  })
})
