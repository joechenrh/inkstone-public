import { render } from '@testing-library/preact'
import { useState } from 'preact/hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMIT_PX, useSwipeBack } from '../../src/web/layout/useSwipeBack.js'

/**
 * jsdom has neither Touch nor TouchEvent, so both are declared here.
 *
 * Worth saying plainly: these are synthetic, and synthetic events are exactly what hid the last
 * bug in this file — a real browser takes a moving finger over as a scroll, which no dispatched
 * event ever does. What these can check is the decision logic. Whether the gesture survives the
 * browser is a question only a browser answers.
 */
function touchAt(target: EventTarget, x: number, y: number) {
  return { identifier: 1, target, clientX: x, clientY: y } as unknown as Touch
}

class TestTouchEvent extends UIEvent {
  readonly touches: TouchList
  readonly changedTouches: TouchList
  #prevented = false
  constructor(type: string, init: { touches: Touch[]; cancelable?: boolean; bubbles?: boolean }) {
    super(type, { bubbles: init.bubbles ?? true, cancelable: init.cancelable ?? true })
    const list = init.touches as unknown as TouchList
    this.touches = list
    this.changedTouches = list
  }

  override preventDefault(): void {
    this.#prevented = true
    super.preventDefault()
  }

  get prevented(): boolean { return this.#prevented }
}

let onBack: ReturnType<typeof vi.fn>
let enabled: boolean

function Harness({ late = false }: { late?: boolean }) {
  const swipe = useSwipeBack({ enabled: () => enabled, onBack })
  // `late` mounts the pane on a second render, which is what the phone actually does when it
  // moves from the list to the document — and what an effect keyed on a ref would miss.
  const [shown, setShown] = useState(!late)
  if (late && !shown) queueMicrotask(() => { setShown(true) })
  if (!shown) return <div />

  return (
    <>
      {/* The list, which is what moves. */}
      <aside ref={swipe.reveal} data-testid="sheet" />
      {/* The document, which is where the gesture is heard and which never moves. */}
      <main ref={swipe.listen} data-testid="pane">
        <p data-testid="prose">ordinary text</p>
        <div data-testid="table" class="wide">a table that scrolls sideways</div>
      </main>
    </>
  )
}

/** jsdom has no layout, so a scroller is declared rather than measured. */
function makeScroller(el: HTMLElement, wider: boolean) {
  Object.defineProperty(el, 'scrollWidth', { value: wider ? 500 : 100, configurable: true })
  Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true })
}

/**
 * Returns the last move event, so a test can ask whether the gesture claimed it.
 *
 * The moves are interpolated along the real vector rather than jumping sideways first. An earlier
 * version sent a horizontal step to clear the slop, which armed the gesture before the caller's
 * own direction was ever seen — and so reported that a vertical drag was taken.
 */
function swipe(from: HTMLElement, { dx, dy = 0, steps = 4 }: { dx: number; dy?: number; steps?: number }) {
  from.dispatchEvent(new TestTouchEvent('touchstart', { touches: [touchAt(from, 0, 0)] }))
  let last = new TestTouchEvent('touchmove', { touches: [touchAt(from, 0, 0)] })
  for (let i = 1; i <= steps; i++) {
    last = new TestTouchEvent('touchmove', {
      touches: [touchAt(from, (dx * i) / steps, (dy * i) / steps)],
    })
    from.dispatchEvent(last)
  }
  from.dispatchEvent(new TestTouchEvent('touchend', { touches: [] }))
  // The panel finishes its travel before anything is committed, so the clock has to move too.
  vi.advanceTimersByTime(400)
  return last
}

beforeEach(() => {
  vi.useFakeTimers()
  onBack = vi.fn()
  enabled = true
})

afterEach(() => {
  vi.useRealTimers()
})

describe('swiping back', () => {
  it('binds to a pane that appears on a later render', async () => {
    // The bug a real browser found and these tests did not: the phone mounts the document pane
    // when it leaves the list, and an effect keyed on `ref.current` never sees it.
    const { findByTestId } = render(<Harness late />)
    const prose = await findByTestId('prose')
    swipe(prose as HTMLElement, { dx: COMMIT_PX + 40 })
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('goes back past the threshold', () => {
    const { getByTestId } = render(<Harness />)
    makeScroller(getByTestId('table') as HTMLElement, true)
    swipe(getByTestId('prose') as HTMLElement, { dx: COMMIT_PX + 10 })
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('springs back under it', () => {
    const { getByTestId } = render(<Harness />)
    swipe(getByTestId('prose') as HTMLElement, { dx: COMMIT_PX - 10 })
    expect(onBack).not.toHaveBeenCalled()
  })

  it('never moves the document — the list is what comes in', () => {
    const { getByTestId } = render(<Harness />)
    swipe(getByTestId('prose') as HTMLElement, { dx: COMMIT_PX + 40 })
    expect((getByTestId('pane') as HTMLElement).style.transform).toBe('')
  })

  it('travels the list in by the distance dragged', () => {
    const { getByTestId } = render(<Harness />)
    const sheet = getByTestId('sheet') as HTMLElement
    swipe(getByTestId('prose') as HTMLElement, { dx: 50 })
    // Back off the left edge once the drag fell short.
    expect(sheet.style.transform).toBe('translateX(calc(-100% + 0px))')
  })

  it('finishes the travel before committing, rather than teleporting', () => {
    const { getByTestId } = render(<Harness />)
    const sheet = getByTestId('sheet') as HTMLElement
    const prose = getByTestId('prose') as HTMLElement
    // Up to the release: mid-travel, and nothing committed yet.
    prose.dispatchEvent(new TestTouchEvent('touchstart', { touches: [touchAt(prose, 0, 0)] }))
    prose.dispatchEvent(new TestTouchEvent('touchmove', { touches: [touchAt(prose, 40, 0)] }))
    prose.dispatchEvent(new TestTouchEvent('touchmove', { touches: [touchAt(prose, 120, 0)] }))
    prose.dispatchEvent(new TestTouchEvent('touchend', { touches: [] }))
    expect(onBack).not.toHaveBeenCalled()
    expect(sheet.style.transition).toContain('transform')

    vi.advanceTimersByTime(400)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(sheet.style.transform).toBe('')
  })

  it('ignores a diagonal, which is scrolling with a wobble', () => {
    const { getByTestId } = render(<Harness />)
    swipe(getByTestId('prose') as HTMLElement, { dx: 100, dy: 90 })
    expect(onBack).not.toHaveBeenCalled()
  })

  it('ignores a leftward drag', () => {
    const { getByTestId } = render(<Harness />)
    swipe(getByTestId('prose') as HTMLElement, { dx: -120 })
    expect(onBack).not.toHaveBeenCalled()
  })

  it('never arms inside something that scrolls sideways', () => {
    // Tables and code blocks are deliberately overflow-x: auto. That drag is theirs.
    const { getByTestId } = render(<Harness />)
    const table = getByTestId('table') as HTMLElement
    makeScroller(table, true)
    swipe(table, { dx: COMMIT_PX + 60 })
    expect(onBack).not.toHaveBeenCalled()
  })

  it('does arm on an element that merely could have scrolled', () => {
    const { getByTestId } = render(<Harness />)
    const table = getByTestId('table') as HTMLElement
    makeScroller(table, false)
    swipe(table, { dx: COMMIT_PX + 60 })
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('takes the gesture away from the browser once it is horizontal', () => {
    // The whole reason this is touch events and not pointer events: a moving finger is a scroll
    // to the browser unless something says otherwise, and it says so by preventing the default.
    const { getByTestId } = render(<Harness />)
    const last = swipe(getByTestId('prose') as HTMLElement, { dx: COMMIT_PX + 40 })
    expect(last.prevented).toBe(true)
  })

  it('leaves a vertical drag to the browser, so the page still scrolls', () => {
    const { getByTestId } = render(<Harness />)
    const last = swipe(getByTestId('prose') as HTMLElement, { dx: 12, dy: 120 })
    expect(last.prevented).toBe(false)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('is off while a sheet covers the document', () => {
    enabled = false
    const { getByTestId } = render(<Harness />)
    swipe(getByTestId('prose') as HTMLElement, { dx: COMMIT_PX + 60 })
    expect(onBack).not.toHaveBeenCalled()
  })

  it('is off while text is selected, because the finger is doing something else', () => {
    const { getByTestId } = render(<Harness />)
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'chosen' } as Selection)
    swipe(getByTestId('prose') as HTMLElement, { dx: COMMIT_PX + 60 })
    expect(onBack).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
