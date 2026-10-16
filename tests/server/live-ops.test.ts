import { describe, expect, it } from 'vitest'
import { MAX_OPS, parseOps } from '../../src/shared/live-ops.js'

/**
 * What an agent is allowed to send, and what it is told when it sends something else.
 *
 * Every string here is read by a language model rather than by a person, which is the whole reason
 * these are tested at all: "400 Bad Request" is a dead end for a caller that could have fixed its
 * own request if anybody had told it which op was wrong.
 */
describe('what an agent is allowed to send', () => {
  it('takes the three ops', () => {
    expect(parseOps([{ find: 'a', replace: 'b' }])).toEqual({ ops: [{ find: 'a', replace: 'b' }] })
    expect(parseOps([{ insertAfterHeading: 'Next week', text: '- x' }]))
      .toEqual({ ops: [{ insertAfterHeading: 'Next week', text: '- x' }] })
    expect(parseOps([{ append: 'tail' }])).toEqual({ ops: [{ append: 'tail' }] })
  })

  it('refuses an empty anchor, because everything matches it', () => {
    expect(parseOps([{ find: '', replace: 'b' }])).toEqual({ error: 'op 0: find cannot be empty' })
    expect(parseOps([{ insertAfterHeading: '', text: 'b' }]))
      .toEqual({ error: 'op 0: insertAfterHeading cannot be empty' })
  })

  it('refuses a whole-document replacement however it is spelled', () => {
    expect(parseOps({ text: 'the whole note' })).toEqual({
      error: 'send ops, not a document: [{"find":…,"replace":…}]',
    })
  })

  it('names the op that is wrong, so an agent can fix that one', () => {
    expect(parseOps([{ append: 'ok' }, { nonsense: 1 }])).toEqual({
      error: 'op 1: expected find/replace, insertAfterHeading/text, or append',
    })
  })

  it('refuses nothing to do, rather than reporting an empty success', () => {
    expect(parseOps([])).toEqual({ error: 'no ops' })
  })

  it('caps the batch', () => {
    const many = Array.from({ length: MAX_OPS + 1 }, () => ({ append: 'x' }))
    expect(parseOps(many)).toEqual({ error: `too many ops: ${MAX_OPS} at a time` })
  })

  it('keeps only the fields it knows, so a stray key cannot ride along', () => {
    expect(parseOps([{ find: 'a', replace: 'b', regex: true }]))
      .toEqual({ ops: [{ find: 'a', replace: 'b' }] })
  })
})
