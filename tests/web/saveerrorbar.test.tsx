import { render } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import { SaveErrorBar } from '../../src/web/components/SaveErrorBar.js'
import { conflict, dismissSaveError, fileError, saveError } from '../../src/web/state/document.js'

beforeEach(() => { fileError.value = null; conflict.value = null })

describe('SaveErrorBar', () => {
  it('shows nothing when the last save worked', () => {
    const { container } = render(<SaveErrorBar />)
    expect(container.querySelector('.ink-conflict')).toBeNull()
  })

  it('reports why the save failed, and offers a retry', () => {
    fileError.value = { kind: 'save', message: 'disk is full' }
    const { container, getByRole } = render(<SaveErrorBar />)
    expect(container.textContent).toContain('disk is full')
    expect(getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  // The conflict is the one failure with a real choice to make, and it has its own bar. Two bars
  // stacked over the same document would be one too many.
  it('stands aside for a conflict', () => {
    fileError.value = { kind: 'save', message: 'The file has changed on disk' }
    conflict.value = { path: 'a.md', content: 'x', rev: '1', modifiedAt: 1 }
    const { container } = render(<SaveErrorBar />)
    expect(container.querySelector('.ink-conflict')).toBeNull()
  })

  /**
   * A note that would not open is not a save that failed.
   *
   * It read "Could not save: not found: assets/eba971d8….webp" — about a file nobody had tried to
   * save — and the Try again beside it would have written the previous note's text.
   */
  it('says which of the two things failed', () => {
    fileError.value = { kind: 'open', path: 'notes/a.md', message: 'not found: notes/a.md' }
    const { container } = render(<SaveErrorBar />)
    expect(container.textContent).toContain('Could not open: not found: notes/a.md')
    expect(container.textContent).not.toContain('Could not save')
  })

  it('dismissing clears the notice without pretending the text was saved', () => {
    fileError.value = { kind: 'save', message: 'network unreachable' }
    dismissSaveError()
    expect(saveError.value).toBeNull()
  })
})
