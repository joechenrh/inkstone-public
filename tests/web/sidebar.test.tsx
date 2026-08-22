import { fireEvent, render, screen } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from '../../src/web/layout/Sidebar.js'
import { sidebarView } from '../../src/web/state/ui.js'
import { tree } from '../../src/web/state/vault.js'

beforeEach(() => {
  sidebarView.value = 'files'
  tree.value = []
  document.body.innerHTML = ''
})

describe('Sidebar', () => {
  it('shows the file tree by default', () => {
    const { container } = render(<Sidebar onOpenFile={() => {}} />)
    expect(container.querySelector('.ink-tree-container')).toBeTruthy()
    expect(container.querySelector('.ink-outline, .ink-outline-empty')).toBeNull()
  })

  it('shows the outline once the view switches', () => {
    sidebarView.value = 'outline'
    const { container } = render(<Sidebar onOpenFile={() => {}} />)
    expect(container.querySelector('.ink-outline, .ink-outline-empty')).toBeTruthy()
    expect(container.querySelector('.ink-tree-container')).toBeNull()
  })

  it('the switcher buttons change the view', () => {
    render(<Sidebar onOpenFile={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Outline' }))
    expect(sidebarView.value).toBe('outline')
    fireEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(sidebarView.value).toBe('files')
  })

  it('marks the active switcher button with aria-pressed', () => {
    render(<Sidebar onOpenFile={() => {}} />)
    expect(screen.getByRole('button', { name: 'Files' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Outline' }).getAttribute('aria-pressed')).toBe('false')
  })

  // The git controls are pinned to the status bar, not hosted here — collapsing the sidebar
  // must not take them away.
  it('does not host the git controls', () => {
    const { container } = render(<Sidebar onOpenFile={() => {}} />)
    expect(container.querySelector('.ink-git-footer')).toBeNull()
  })
})
