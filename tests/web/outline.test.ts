import { describe, expect, it } from 'vitest'
import { readOutline } from '../../src/web/outline/outline.js'

/**
 * Mirrors what the editor produces: headings are direct children of the document surface, and the
 * `##` the caret reveals is a marker span — drawn in the gutter, still present in `textContent`,
 * and not part of the heading's name.
 */
function makeRoot(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

const h = (tag: string, marker: string, text: string) =>
  `<${tag}><span class="ink-marker ink-marker--heading">${marker}</span>${text}</${tag}>`

describe('readOutline', () => {
  it('returns one item per heading, with the level from the tag name', () => {
    const root = makeRoot(h('h1', '# ', 'Title') + h('h3', '### ', 'Deep'))
    expect(readOutline(root).map((i) => i.level)).toEqual([1, 3])
  })

  it('strips the marker span from the text', () => {
    const root = makeRoot(h('h2', '## ', 'Conflict handling'))
    expect(readOutline(root)[0]?.text).toBe('Conflict handling')
  })

  it('keeps the live element reference', () => {
    const root = makeRoot(h('h1', '# ', 'Title'))
    expect(readOutline(root)[0]?.el).toBe(root.querySelector('h1'))
  })

  it('skips non-heading children', () => {
    const root = makeRoot('<p>body</p>' + h('h1', '# ', 'Title') + '<pre>code</pre>')
    expect(readOutline(root)).toHaveLength(1)
  })

  it('only looks at direct children, not nested headings', () => {
    const root = makeRoot('<blockquote>' + h('h1', '# ', 'Quoted') + '</blockquote>')
    expect(readOutline(root)).toEqual([])
  })

  it('covers all six levels', () => {
    const root = makeRoot([1, 2, 3, 4, 5, 6].map((n) => h(`h${n}`, '#'.repeat(n) + ' ', `H${n}`)).join(''))
    expect(readOutline(root).map((i) => i.level)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('returns an empty array for a document with no headings', () => {
    expect(readOutline(makeRoot('<p>just text</p>'))).toEqual([])
  })

  it('returns an empty array for a null root', () => {
    expect(readOutline(null)).toEqual([])
  })

  it('gives an empty string for a heading with no text after the marker', () => {
    const root = makeRoot(h('h2', '## ', ''))
    expect(readOutline(root)[0]?.text).toBe('')
  })
})
