import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { findHeading, findText } from '../../src/web/live/locate.js'

/**
 * Where an op lands, and the two ways it refuses.
 *
 * `prosemirror-model` is pure JavaScript, so this needs no editor and no DOM — a schema of five
 * nodes and one mark is enough to prove the rules the API promises: a match spans inline marks, it
 * never crosses a block, and anything other than exactly one hit is the caller's problem.
 */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
    image: { inline: true, group: 'inline', atom: true, attrs: { src: { default: '' } } },
    text: { group: 'inline' },
  },
  marks: { strong: {} },
})

const doc = (...blocks: unknown[]) => schema.node('doc', null, blocks as never)
const p = (...inline: unknown[]) => schema.node('paragraph', null, inline as never)
const h = (level: number, text: string) => schema.node('heading', { level }, [schema.text(text)])
const t = (text: string) => schema.text(text)
const b = (text: string) => schema.text(text, [schema.mark('strong')])

describe('finding text to replace', () => {
  it('finds it once, in document positions', () => {
    const found = findText(doc(p(t('before and after'))), 'and')
    expect(found).toHaveLength(1)
    expect(found[0]).toEqual({ from: 8, to: 11 })
  })

  it('reports every hit, because two is ambiguous and the caller must know', () => {
    expect(findText(doc(p(t('a a a'))), 'a')).toHaveLength(3)
  })

  it('reports none rather than guessing', () => {
    expect(findText(doc(p(t('nothing here'))), 'absent')).toEqual([])
  })

  it('spans inline marks: what a reader sees as one phrase is one phrase', () => {
    const found = findText(doc(p(t('very '), b('bold'), t(' text'))), 'very bold text')
    expect(found).toHaveLength(1)
  })

  it('never crosses a block: two paragraphs are not one sentence', () => {
    expect(findText(doc(p(t('end of one')), p(t('start of two'))), 'one start')).toEqual([])
  })

  it('never crosses an atom: a picture is one object, not nothing', () => {
    const withPicture = doc(p(t('see '), schema.node('image', { src: 'x.webp' }), t(' here')))
    expect(findText(withPicture, 'see  here')).toEqual([])
    expect(findText(withPicture, 'see ')).toHaveLength(1)
  })

  it('finds text in a heading too: a heading is a block with text in it', () => {
    expect(findText(doc(h(2, 'Next week')), 'Next')).toHaveLength(1)
  })

  it('matches an empty needle nowhere, rather than everywhere', () => {
    expect(findText(doc(p(t('anything'))), '')).toEqual([])
  })
})

describe('finding a heading', () => {
  it('matches its text, at any level', () => {
    const found = findHeading(doc(h(1, 'Weekly'), p(t('x')), h(2, 'Next week')), 'Next week')
    expect(found).toHaveLength(1)
  })

  it('reports every heading with that text', () => {
    expect(findHeading(doc(h(2, 'Notes'), p(t('x')), h(3, 'Notes')), 'Notes')).toHaveLength(2)
  })

  it('ignores a paragraph that happens to say the same thing', () => {
    expect(findHeading(doc(p(t('Next week'))), 'Next week')).toEqual([])
  })

  it('wants the whole heading, not a word of it', () => {
    expect(findHeading(doc(h(2, 'Next week')), 'Next')).toEqual([])
  })
})
