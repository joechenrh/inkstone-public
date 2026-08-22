import { render } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import { TopBar } from '../../src/web/layout/TopBar.js'
import { dirty } from '../../src/web/state/document.js'
import { currentPath } from '../../src/web/state/vault.js'

beforeEach(() => { dirty.value = false; currentPath.value = null })

describe('TopBar', () => {
  it('shows a dot in the breadcrumb when there are unsaved changes and a file is open', () => {
    currentPath.value = 'notes/a.md'; dirty.value = true
    const { container } = render(<TopBar onOpenSettings={() => {}} />)
    expect(container.querySelector('.ink-unsaved-dot')).toBeTruthy()
  })
  it('shows no dot when there are no unsaved changes', () => {
    currentPath.value = 'notes/a.md'; dirty.value = false
    const { container } = render(<TopBar onOpenSettings={() => {}} />)
    expect(container.querySelector('.ink-unsaved-dot')).toBeNull()
  })
  it('renders the gear settings icon', () => {
    const { container } = render(<TopBar onOpenSettings={() => {}} />)
    expect(container.querySelector('.ink-icon-gear')).toBeTruthy()
  })
  it('no longer renders save-state text', () => {
    currentPath.value = 'a.md'; dirty.value = true
    const { getByText } = render(<TopBar onOpenSettings={() => {}} />)
    expect(() => getByText('Unsaved')).toThrow()
  })
  /**
   * The breadcrumb names what you are looking at.
   *
   * With nothing open there is nothing to name, and the screen underneath is already the empty
   * state — the mark, Recent, and what to start. "No file open" restated what was in plain sight.
   */
  it('says nothing when no file is open', () => {
    currentPath.value = null
    const { container } = render(<TopBar onOpenSettings={() => {}} />)
    expect(container.querySelector('.ink-breadcrumb')?.textContent).toBe('')
  })
})
