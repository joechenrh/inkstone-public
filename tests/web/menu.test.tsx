import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import { MenuButton } from '../../src/web/components/Menu.js'

function items(onPick = vi.fn()) {
  return [
    { label: 'New file', icon: <svg />, onSelect: onPick },
    { label: 'Rename', icon: <svg />, onSelect: vi.fn() },
    { label: 'Delete', icon: <svg />, danger: true, onSelect: vi.fn() },
  ]
}

function open(label = 'Actions') {
  fireEvent.click(screen.getByLabelText(label))
}

describe('MenuButton', () => {
  it('renders nothing until the trigger is clicked', () => {
    const { container } = render(<MenuButton label="Actions" items={items()}>x</MenuButton>)
    expect(container.querySelector('.ink-menu')).toBeNull()
    open()
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('marks the trigger expanded while open', () => {
    render(<MenuButton label="Actions" items={items()}>x</MenuButton>)
    const trigger = screen.getByLabelText('Actions')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    open()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('clicking the trigger again closes it', () => {
    render(<MenuButton label="Actions" items={items()}>x</MenuButton>)
    open()
    open()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('selecting an item fires onSelect and closes', () => {
    const pick = vi.fn()
    render(<MenuButton label="Actions" items={items(pick)}>x</MenuButton>)
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'New file' }))
    expect(pick).toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Escape closes it', () => {
    render(<MenuButton label="Actions" items={items()}>x</MenuButton>)
    open()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a mousedown outside closes it', () => {
    render(<MenuButton label="Actions" items={items()}>x</MenuButton>)
    open()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a mousedown inside keeps it open', () => {
    render(<MenuButton label="Actions" items={items()}>x</MenuButton>)
    open()
    fireEvent.mouseDown(screen.getByRole('menu'))
    expect(screen.queryByRole('menu')).toBeTruthy()
  })

  it('marks the destructive item so it can be coloured apart', () => {
    render(<MenuButton label="Actions" items={items()}>x</MenuButton>)
    open()
    expect(screen.getByRole('menuitem', { name: 'Delete' }).className).toContain('danger')
  })
})
