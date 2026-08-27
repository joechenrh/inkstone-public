import { render } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import { OutlinePanel } from '../../src/web/outline/OutlinePanel.js'
import { content } from '../../src/web/state/document.js'
import { currentPath } from '../../src/web/state/vault.js'

/** Stands in for the editor: OutlinePanel finds the scroller by selector. */
function mountEditor(headingsHtml: string) {
  const wrap = document.createElement('div')
  wrap.className = 'milkdown'
  const reset = document.createElement('pre')
  // The shared surface class, not Vditor's own — the panel asks `documentRoot()` now, so this is
  // what makes the fixture findable whichever engine is mounted. See `editor/surface.ts`.
  reset.className = 'ink-doc'
  reset.innerHTML = headingsHtml
  wrap.appendChild(reset)
  document.body.appendChild(wrap)
  return wrap
}

const h = (tag: string, marker: string, text: string) =>
  `<${tag}><span class="ink-marker ink-marker--heading">${marker}</span>${text}</${tag}>`

beforeEach(() => {
  document.body.innerHTML = ''
  currentPath.value = 'notes/a.md'
  content.value = '# Title'
})

describe('OutlinePanel', () => {
  // Queries are scoped to `container`, not `screen`: the stand-in editor is also in
  // document.body, so a global text query would match the real headings as well.
  it('renders one row per heading', () => {
    mountEditor(h('h1', '# ', 'Title') + h('h2', '## ', 'Section'))
    const { container } = render(<OutlinePanel />)
    const rows = Array.from(container.querySelectorAll('.ink-outline-row')).map((r) => r.textContent)
    expect(rows).toEqual(['Title', 'Section'])
  })

  // Effects run after paint, so an empty initial state renders one frame of "No headings"
  // every time the outline view is switched on.
  it('renders the rows on the very first render, with no empty-state frame', () => {
    mountEditor(h('h1', '# ', 'Title'))
    const { container } = render(<OutlinePanel />)
    expect(container.querySelector('.ink-outline-empty')).toBeNull()
    expect(container.querySelectorAll('.ink-outline-row')).toHaveLength(1)
  })

  it('marks the depth with a level class so CSS can indent', () => {
    mountEditor(h('h3', '### ', 'Deep'))
    const { container } = render(<OutlinePanel />)
    expect(container.querySelector('.ink-outline-row.ink-outline-l3')).toBeTruthy()
  })

  it('shows an empty state when the document has no headings', () => {
    mountEditor('<p>body only</p>')
    const { container } = render(<OutlinePanel />)
    expect(container.querySelector('.ink-outline-empty')).toBeTruthy()
  })

  it('shows an empty state when no file is open', () => {
    currentPath.value = null
    mountEditor('')
    const { container } = render(<OutlinePanel />)
    expect(container.querySelector('.ink-outline-empty')).toBeTruthy()
  })

  it('renders a placeholder for a heading with no text, keeping the row clickable', () => {
    mountEditor(h('h2', '## ', ''))
    const { container } = render(<OutlinePanel />)
    const row = container.querySelector('.ink-outline-row')
    expect(row).toBeTruthy()
    expect(row?.textContent?.trim()).not.toBe('')
  })

  it('gives each row a title attribute so a truncated heading is readable on hover', () => {
    mountEditor(h('h2', '## ', 'A very long heading that will certainly be truncated'))
    const { container } = render(<OutlinePanel />)
    expect(container.querySelector('.ink-outline-row')?.getAttribute('title'))
      .toBe('A very long heading that will certainly be truncated')
  })
})
