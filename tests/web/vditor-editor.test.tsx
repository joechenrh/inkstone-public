// Vditor cannot be fully mounted in jsdom (it requires real DOM APIs including
// contenteditable behaviour and lute.wasm — see task-2-report.md for probe
// details). Deep editor behaviour is covered by Playwright in Task 6.
//
// This smoke test verifies:
//   1. The module imports without throwing.
//   2. VditorEditor is exported as a function (Preact function component).
//   3. Rendering the component via @testing-library/preact does not throw, and
//      the host div with class "ink-editor" is present in the DOM.
//      (Vditor constructor is mocked so no real DOM manipulation occurs.)
import { render } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import { VditorEditor } from '../../src/web/editor/VditorEditor.js'

// Mock the Vditor constructor so it never touches real DOM APIs not
// available in jsdom (e.g. contenteditable, lute.wasm fetch).
vi.mock('vditor', () => ({
  default: vi.fn().mockImplementation(() => ({
    setValue: vi.fn(),
    getValue: vi.fn(() => ''),
    destroy: vi.fn(),
  })),
}))

describe('VditorEditor', () => {
  it('exports VditorEditor as a function', () => {
    expect(typeof VditorEditor).toBe('function')
  })

  it('renders an .ink-editor container div without throwing', () => {
    const { container } = render(<VditorEditor />)
    expect(container.querySelector('.ink-editor')).toBeTruthy()
  })
})

describe('Vditor edit-mode hotkeys', () => {
  // Ctrl/Cmd+Alt+7/8/9 switch Vditor between wysiwyg / ir / sv. This app only supports
  // IR — the Lapis theme and every shell rule are scoped to .vditor-ir — and there is no
  // UI to switch back, so a stray press leaves a broken editor with no recovery.
  it('swallows Cmd+Alt+7/8/9 before they reach Vditor', () => {
    const { container } = render(<VditorEditor />)
    const host = container.querySelector('.ink-editor') as HTMLElement
    for (const code of ['Digit7', 'Digit8', 'Digit9']) {
      const e = new KeyboardEvent('keydown', { code, metaKey: true, altKey: true, cancelable: true, bubbles: true })
      host.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(true)
    }
  })

  it('leaves Cmd+Alt+1..6 alone so heading shortcuts keep working', () => {
    const { container } = render(<VditorEditor />)
    const host = container.querySelector('.ink-editor') as HTMLElement
    for (const code of ['Digit1', 'Digit6']) {
      const e = new KeyboardEvent('keydown', { code, metaKey: true, altKey: true, cancelable: true, bubbles: true })
      host.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)
    }
  })
})
