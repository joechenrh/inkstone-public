import { useEffect, useRef, useState } from 'preact/hooks'

/**
 * Long enough that a fast load never shows a placeholder at all.
 *
 * Measured on this app: opening a note off a local disk takes 37ms and the tree 21ms, so on a
 * desktop nothing is ever drawn. Over a 200ms round trip both cross this line, which is the case
 * the placeholder exists for.
 */
export const APPEAR_AFTER_MS = 180

/**
 * And long enough, once it is up, that it is not a flash.
 *
 * A load that resolves at 190ms would otherwise show the placeholder for ten milliseconds — worse
 * than either showing it properly or not at all.
 */
export const STAY_FOR_MS = 300

/**
 * Whether to draw a placeholder for something still loading.
 *
 * The two thresholds are both there to prevent a flicker rather than to announce a wait: nothing
 * appears before the first, and nothing disappears before the second has passed since it did.
 */
export function usePendingPlaceholder(pending: boolean): boolean {
  const [visible, setVisible] = useState(false)
  const shownAt = useRef(0)

  useEffect(() => {
    if (pending) {
      const appear = setTimeout(() => {
        shownAt.current = Date.now()
        setVisible(true)
      }, APPEAR_AFTER_MS)
      return () => { clearTimeout(appear) }
    }

    if (!visible) return
    // However much of its minimum is left. Zero when it has already been up long enough.
    const left = Math.max(0, STAY_FOR_MS - (Date.now() - shownAt.current))
    const hide = setTimeout(() => { setVisible(false) }, left)
    return () => { clearTimeout(hide) }
  }, [pending, visible])

  return visible
}
