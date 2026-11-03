import type { RefObject } from 'preact'
import { useLayoutEffect } from 'preact/hooks'

/** Keep a modal's keyboard interaction inside it, then return to the control that opened it. */
export function useModalFocus(ref: RefObject<HTMLElement>, open: boolean, initial?: string): void {
  useLayoutEffect(() => {
    const modal = ref.current
    if (!open || !modal) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const candidates = () => Array.from(modal.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')

    modal.tabIndex = -1
    const first = (initial ? modal.querySelector<HTMLElement>(initial) : null) ?? candidates()[0] ?? modal
    first.focus({ preventScroll: true })

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const elements = candidates()
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (!first || !last) {
        event.preventDefault()
        modal.focus({ preventScroll: true })
        return
      }
      const active = document.activeElement
      // Safari may omit buttons from native Tab order. Own the whole cycle so it cannot leave
      // through an intermediate control, not just through the first or last one.
      const at = elements.indexOf(active as HTMLElement)
      const next = at < 0 ? (event.shiftKey ? last : first)
        : elements[(at + (event.shiftKey ? -1 : 1) + elements.length) % elements.length]!
      event.preventDefault()
      // Keyboard traversal reveals controls below a scrollable dialog's fold.
      next.focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open])
}
