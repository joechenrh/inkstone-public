import { useMemo } from 'preact/hooks'

/** How far right the pane must travel before releasing goes back. */
export const COMMIT_PX = 72
/** How much straighter than vertical the drag has to be. A diagonal is scrolling with a wobble. */
export const STRAIGHTNESS = 2
/** Ignore the first few pixels: a tap wanders, and a press should not nudge the pane. */
const SLOP_PX = 6
/** How long the panel takes to finish its travel, in step with the CSS transition below. */
const SETTLE_MS = 240

export interface SwipeBackOptions {
  /** Whether the gesture is live at all — false while a sheet covers the document. */
  enabled: () => boolean
  onBack: () => void
  /** Called once when the drag proves itself horizontal, and again when it settles. */
  onDragging?: (dragging: boolean) => void
}

/**
 * Swipe right on the document to go back to the list.
 *
 * The gesture is the rare addition that costs no interface: no button, no row, no bar. It is also
 * invisible, which is why the top bar's `‹` stays — that is how anyone finds out the screen can be
 * left at all, and this only makes it cheaper for someone who already knows.
 *
 * Three things it must not break, and each decides part of the shape:
 *
 * - **Safari's own edge swipe.** iOS uses a swipe from the very edge for browser back. Fighting it
 *   loses, so this starts *anywhere* rather than at the edge and leaves that zone alone.
 * - **Sideways scrollers.** Tables and code blocks are deliberately `overflow-x: auto`; a drag
 *   beginning inside one belongs to it, so the gesture never arms there.
 * - **Selecting text.** A selection means the finger is doing something else entirely.
 *
 * **Touch events, not pointer events, and `preventDefault` rather than `touch-action`.** The first
 * version used pointer events and worked perfectly against synthetic ones — and not at all on a
 * real phone. A finger that moves is a scroll as far as the browser is concerned: it takes the
 * gesture over and fires `pointercancel`, and no further move ever arrives. The usual answer,
 * `touch-action: pan-y` on the pane, cannot be used here: touch-action is intersected up the
 * ancestor chain, so forbidding horizontal panning on the pane forbids it inside the tables and
 * code blocks too — the very scrolling this gesture exists to leave alone. Calling
 * `preventDefault()` on `touchmove`, and only once the drag has proved itself horizontal, claims
 * exactly this gesture and nothing else.
 *
 * **The document does not move; the whole list slides in over it, from the left.**
 *
 * Moving the document off to reveal the list was tried first and is wrong: it puts the thing being
 * read in motion, and reads as the page being dragged away rather than as a menu arriving.
 *
 * The list is a panel that travels, not a shape that is unmasked. That is the asked-for feel, and
 * it costs one thing worth knowing: a full-width panel entering from the left leads with its
 * *right* edge, so mid-drag the strip on screen is the right side of the list rather than the
 * filenames. It resolves the moment the gesture completes.
 *
 * Returns two **callback refs**, not effects over a `useRef`. The panes are mounted and unmounted
 * as the phone moves between its two screens, and a `useLayoutEffect` keyed on `ref.current`
 * misses that: the ref is still null while the render that creates the element is running, so the
 * effect sees null, and unless something else causes another render it never binds. The unit
 * tests did not catch it — their harness mounts on the first render — and a real browser did.
 */
export interface SwipeBackRefs {
  /** The document: where the gesture is listened for, and which never moves. */
  listen: (el: HTMLElement | null) => void
  /** The list: parked off the left edge, and drawn in by the finger. */
  reveal: (el: HTMLElement | null) => void
}

export function useSwipeBack(options: SwipeBackOptions): SwipeBackRefs {
  const { enabled, onBack, onDragging } = options

  return useMemo(() => {
    let el: HTMLElement | null = null
    let sheet: HTMLElement | null = null
    let touch: number | null = null
    let startX = 0
    let startY = 0
    let dx = 0
    let dy = 0
    /** False until the drag has passed the slop and proved itself horizontal. */
    let moving = false
    /** True from the moment the list is asked for until it has finished settling. */
    let dragging = false

    /** How far the list has travelled in from the left edge, in pixels. */
    const settle = (to: number, animate: boolean) => {
      if (sheet === null) return
      sheet.style.transition = animate ? `transform ${SETTLE_MS}ms cubic-bezier(.2,.7,.3,1)` : ''
      sheet.style.transform = `translateX(calc(-100% + ${Math.max(0, to)}px))`
    }

    /** The list is the screen now, so it stops being a thing that travels. */
    const park = () => {
      if (sheet === null) return
      sheet.style.transition = ''
      sheet.style.transform = ''
    }

    const reset = () => {
      touch = null
      moving = false
      dx = 0
      dy = 0
    }

    /** The nearest ancestor that scrolls sideways, if the gesture started inside one. */
    const sideScroller = (target: EventTarget | null): boolean => {
      let node = target instanceof Element ? target : null
      while (node !== null && node !== el) {
        if (node.scrollWidth > node.clientWidth + 1) return true
        node = node.parentElement
      }
      return false
    }

    const onStart = (e: TouchEvent) => {
      // A second finger is a pinch or a two-handed scroll, not this.
      if (touch !== null || e.touches.length !== 1 || !enabled()) return
      const t = e.touches[0]!
      if (sideScroller(t.target)) return
      if ((window.getSelection()?.toString().length ?? 0) > 0) return

      touch = t.identifier
      startX = t.clientX
      startY = t.clientY
      if (el !== null) el.style.transition = ''
    }

    const find = (list: TouchList): Touch | null => {
      for (let i = 0; i < list.length; i++) {
        if (list[i]!.identifier === touch) return list[i]!
      }
      return null
    }

    const onMove = (e: TouchEvent) => {
      if (touch === null) return
      const t = find(e.touches)
      if (t === null) return
      dx = t.clientX - startX
      dy = t.clientY - startY

      if (!moving) {
        if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return
        // The direction is decided once, at the moment the drag becomes a drag. Re-deciding it
        // mid-gesture is what makes a pane twitch while someone is scrolling.
        if (dx <= 0 || Math.abs(dx) <= STRAIGHTNESS * Math.abs(dy)) { reset(); return }
        moving = true
        dragging = true
        // The list has to exist before it can slide, and it is not mounted on this screen.
        onDragging?.(true)
      }

      // Claim it, so the browser stops trying to scroll with the same finger. Only from here:
      // before this the drag might still have been a scroll, and taking those would make the
      // page feel stuck.
      if (e.cancelable) e.preventDefault()
      settle(Math.max(0, dx), false)
    }

    const onEnd = () => {
      if (touch === null) return
      const commit = moving && dx > COMMIT_PX && Math.abs(dx) > STRAIGHTNESS * Math.abs(dy)
      const wasMoving = moving
      reset()
      if (!wasMoving) return
      if (commit) {
        // Finish the journey rather than teleporting: the panel was mid-travel when the finger
        // left, and clearing the transform there put it in place with a jump.
        settle(sheet?.offsetWidth ?? 0, true)
        setTimeout(() => {
          park()
          onBack()
          dragging = false
          onDragging?.(false)
        }, SETTLE_MS)
      } else {
        // Back off the left edge, then let it unmount once the animation has finished.
        settle(0, wasMoving)
        setTimeout(() => { dragging = false; onDragging?.(false) }, SETTLE_MS)
      }
    }

    return {
      listen: (next: HTMLElement | null) => {
        if (el === next) return
        if (el !== null) {
          el.removeEventListener('touchstart', onStart)
          el.removeEventListener('touchmove', onMove)
          el.removeEventListener('touchend', onEnd)
          el.removeEventListener('touchcancel', onEnd)
        }
        el = next
        reset()
        if (el === null) return
        el.addEventListener('touchstart', onStart, { passive: true })
        // Not passive: this one has to be able to take the gesture away from the browser.
        el.addEventListener('touchmove', onMove, { passive: false })
        el.addEventListener('touchend', onEnd, { passive: true })
        el.addEventListener('touchcancel', onEnd, { passive: true })
      },

      reveal: (next: HTMLElement | null) => {
        sheet = next
        // It arrives already off the edge, so the first frame of a drag does not flash it in.
        if (sheet !== null && dragging) settle(Math.max(0, dx), false)
      },
    }
  }, [])
}
