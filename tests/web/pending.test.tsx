import { render } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEAR_AFTER_MS, STAY_FOR_MS, usePendingPlaceholder } from '../../src/web/state/pending.js'

let pending = false

function Harness() {
  return <div data-testid="out">{usePendingPlaceholder(pending) ? 'shown' : 'hidden'}</div>
}

beforeEach(() => { vi.useFakeTimers(); pending = false })
afterEach(() => { vi.useRealTimers() })

/** Re-render with the current `pending`, then let the timers that changed run. */
function tick(ms: number, rerender: () => void) {
  rerender()
  vi.advanceTimersByTime(ms)
  rerender()
}

describe('the delayed placeholder', () => {
  it('shows nothing at all when the wait is shorter than the threshold', () => {
    pending = true
    const { getByTestId, rerender } = render(<Harness />)
    tick(APPEAR_AFTER_MS - 20, () => rerender(<Harness />))
    expect(getByTestId('out').textContent).toBe('hidden')

    // Resolved before it would have appeared: it never does.
    pending = false
    tick(1000, () => rerender(<Harness />))
    expect(getByTestId('out').textContent).toBe('hidden')
  })

  it('appears once the wait passes the threshold', () => {
    pending = true
    const { getByTestId, rerender } = render(<Harness />)
    tick(APPEAR_AFTER_MS + 20, () => rerender(<Harness />))
    expect(getByTestId('out').textContent).toBe('shown')
  })

  it('stays its minimum, so a wait that ends just after it appears is not a flash', () => {
    pending = true
    const { getByTestId, rerender } = render(<Harness />)
    tick(APPEAR_AFTER_MS + 10, () => rerender(<Harness />))
    expect(getByTestId('out').textContent).toBe('shown')

    pending = false
    tick(STAY_FOR_MS - 50, () => rerender(<Harness />))
    expect(getByTestId('out').textContent).toBe('shown')

    tick(60, () => rerender(<Harness />))
    expect(getByTestId('out').textContent).toBe('hidden')
  })
})
