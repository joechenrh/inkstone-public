import { describe, expect, it } from 'vitest'
import { isDateHeading, localToday, planToday, type DateHeading } from '../../src/web/editor/today.js'

/**
 * Where today's section goes.
 *
 * The part with the decisions in it, tested without a document: which day is today where the
 * reader is, whether the note already has one, and where a new one belongs in a file whose order
 * nobody declared.
 */

const days = (...spec: [string, number][]): DateHeading[] =>
  spec.map(([date, at]) => ({ date, at, level: 2 }))

describe('today, where the reader is', () => {
  it('is the local date, not the UTC one', () => {
    // 2026-10-30 23:30 in UTC+8 is still the 30th there and already the 31st in UTC. A journal
    // entry written at half past eleven belongs to the day the person is having.
    const lateEvening = new Date(2026, 9, 30, 23, 30)
    expect(localToday(lateEvening)).toBe('2026-10-30')
  })

  it('pads, so the strings sort the way the dates do', () => {
    expect(localToday(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('what counts as a day', () => {
  it('is a heading that is nothing but a date', () => {
    expect(isDateHeading('2026-10-30')).toBe(true)
    expect(isDateHeading('  2026-10-30 ')).toBe(true)
    expect(isDateHeading('2026-10-30 周会')).toBe(false)
    expect(isDateHeading('Notes')).toBe(false)
  })
})

describe('planning', () => {
  it('finds today when the note already has it, rather than writing a second one', () => {
    const plan = planToday(days(['2026-10-26', 3], ['2026-10-30', 7]), '2026-10-30')
    expect(plan).toEqual({ found: 7 })
  })

  it('puts the first day of a note at the end, under whatever is already there', () => {
    expect(planToday([], '2026-10-30')).toEqual({ before: null, level: 2 })
  })

  it('appends in a note whose days ascend', () => {
    const plan = planToday(days(['2026-09-02', 2], ['2026-10-26', 5]), '2026-10-30')
    expect(plan).toEqual({ before: null, level: 2 })
  })

  it('goes to the top in a note whose days descend', () => {
    const plan = planToday(days(['2026-10-26', 2], ['2026-09-02', 5]), '2026-10-30')
    expect(plan).toEqual({ before: 2, level: 2 })
  })

  it('goes between the right two days, not merely at an end', () => {
    // Back-filling a day that was missed: ascending, so it belongs before the later one.
    const plan = planToday(days(['2026-09-02', 2], ['2026-10-26', 5]), '2026-09-20')
    expect(plan).toEqual({ before: 5, level: 2 })
  })

  it('back-fills the other way round too', () => {
    const plan = planToday(days(['2026-10-26', 2], ['2026-09-02', 5]), '2026-09-20')
    expect(plan).toEqual({ before: 5, level: 2 })
  })

  it('uses the level the note already uses', () => {
    const third: DateHeading[] = [{ date: '2026-10-26', at: 2, level: 3 }]
    expect(planToday(third, '2026-10-30')).toEqual({ before: null, level: 3 })
  })

  it('treats a note with one day as ascending, which is how a journal starts', () => {
    const plan = planToday(days(['2026-10-26', 2]), '2026-10-30')
    expect(plan).toEqual({ before: null, level: 2 })
  })
})
