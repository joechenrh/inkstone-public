import { describe, expect, it } from 'vitest'
import { blockAtLine, blockAtOffset, blockLines, lineAtOffset, offsetOfBlock, offsetOfLine } from '../../src/web/editor/source-sync.js'

/**
 * The block scanner behind keeping your place when the source opens.
 *
 * What it has to agree with is the *rendered* document's list of top-level blocks, because that is
 * the other half of the match. Every case here is one where a naive "blank lines separate blocks"
 * reading disagrees with what is on screen.
 */
describe('blockLines', () => {
  it('counts paragraphs separated by blank lines', () => {
    expect(blockLines('one\n\ntwo\n\nthree\n')).toEqual([0, 2, 4])
  })

  it('keeps a fence whole, blank lines and headings inside it included', () => {
    const md = ['before', '', '```js', '', '# not a heading', '', '```', '', 'after'].join('\n')
    expect(blockLines(md)).toEqual([0, 2, 8])
  })

  it('gives a heading its own block even without a blank line after it', () => {
    expect(blockLines('# Title\nthe paragraph under it\n')).toEqual([0, 1])
  })

  it('keeps a loose list together, because it is one list on screen', () => {
    const md = ['* one', '', '* two', '', '* three'].join('\n')
    expect(blockLines(md)).toEqual([0])
  })

  it('ends a list at a paragraph', () => {
    const md = ['* one', '* two', '', 'a paragraph'].join('\n')
    expect(blockLines(md)).toEqual([0, 3])
  })

  it('keeps a table and a quote whole', () => {
    const md = ['| a | b |', '| - | - |', '| 1 | 2 |', '', '> quoted', '> still quoted'].join('\n')
    expect(blockLines(md)).toEqual([0, 4])
  })

  it('has no blocks in an empty document', () => {
    expect(blockLines('')).toEqual([])
    expect(blockLines('\n\n\n')).toEqual([])
  })
})

describe('finding the way back', () => {
  const md = ['# Title', '', 'first paragraph', '', '```js', 'const x = 1', '```', '', 'last'].join('\n')

  it('maps a line to its block', () => {
    expect(blockAtLine(md, 0)).toBe(0)
    expect(blockAtLine(md, 2)).toBe(1)
    // A line inside the fence belongs to the fence.
    expect(blockAtLine(md, 5)).toBe(2)
    expect(blockAtLine(md, 8)).toBe(3)
  })

  it('maps a block to the offset its first line starts at', () => {
    expect(offsetOfBlock(md, 0)).toBe(0)
    expect(md.slice(offsetOfBlock(md, 1), offsetOfBlock(md, 1) + 5)).toBe('first')
    expect(md.slice(offsetOfBlock(md, 2), offsetOfBlock(md, 2) + 5)).toBe('```js')
    expect(md.slice(offsetOfBlock(md, 3))).toBe('last')
  })

  it('clamps an index that is past the end rather than failing', () => {
    expect(offsetOfBlock(md, 99)).toBe(offsetOfBlock(md, 3))
    expect(offsetOfBlock('', 3)).toBe(0)
  })

  it('round-trips an offset through a block index', () => {
    const offset = md.indexOf('const x')
    expect(blockAtOffset(md, offset)).toBe(2)
    expect(lineAtOffset(md, offset)).toBe(5)
    expect(offsetOfLine(md, 5)).toBe(md.indexOf('const x'))
  })
})
