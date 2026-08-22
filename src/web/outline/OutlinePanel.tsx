import { useEffect, useState } from 'preact/hooks'
import { content } from '../state/document.js'
import { currentPath } from '../state/vault.js'
import { readOutline, type OutlineItem } from './outline.js'
import './outline.css'
import { documentRoot } from '../editor/surface.js'


/** Distance from the top of the viewport a jumped-to heading comes to rest at. */
const JUMP_OFFSET = 24
/** A heading counts as "current" once its top passes this far down the viewport. */
const ACTIVE_OFFSET = 72

function scroller(): HTMLElement | null {
  return documentRoot()
}

export interface OutlinePanelProps {
  /** Called after a heading is jumped to. The phone uses it to close the sheet it opened in. */
  onJump?: () => void
}

export function OutlinePanel({ onJump }: OutlinePanelProps = {}) {
  // Lazy initialiser rather than `useState([])`: effects run after paint, so starting empty
  // renders one frame of the "No headings" empty state every time the view is switched on.
  const [items, setItems] = useState<OutlineItem[]>(() => readOutline(scroller()))
  const [activeIndex, setActiveIndex] = useState(-1)

  /**
   * Recompute from the document itself, not from the saved text.
   *
   * This used to depend on `content`, which Vditor updates on an ~800ms debounce — so the outline
   * was measured at **935ms behind the caret**, and while somebody types continuously the debounce
   * keeps resetting and it can stay behind for as long as they keep writing. That is the "outline
   * doesn't react, you have to wait a while" report.
   *
   * `readOutline` reads the live DOM, and the DOM is already correct the instant Vditor edits it.
   * The debounce was never anything but the wrong trigger. Measured over a real 30,000-character
   * note with 41 headings: **0.9ms a scan**, so watching the DOM costs nothing worth saving.
   *
   * Coalesced on a frame, because a single keystroke fires several mutations and the answer cannot
   * change more than once per paint.
   */
  useEffect(() => {
    const el = scroller()
    if (!el) return
    let queued = false
    const rescan = () => { queued = false; setItems(readOutline(el)) }

    rescan()
    const observer = new MutationObserver(() => {
      if (queued) return
      queued = true
      requestAnimationFrame(rescan)
    })
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => { observer.disconnect() }
    // `content` is still a dependency, but only to re-attach after Vditor replaces the scroller
    // wholesale on a file switch — not as the thing that drives the scan.
  }, [currentPath.value, content.value === ''])

  // Track which heading the reader is currently under. Throttled with rAF: a scroll
  // listener that reads rects on every event forces layout on every frame of a fling.
  useEffect(() => {
    const el = scroller()
    if (!el) return
    let queued = false

    const measure = () => {
      queued = false
      const top = el.getBoundingClientRect().top + ACTIVE_OFFSET
      let current = -1
      items.forEach((item, i) => {
        if (item.el.getBoundingClientRect().top <= top) current = i
      })
      setActiveIndex(current)
    }

    const onScroll = () => {
      if (queued) return
      queued = true
      requestAnimationFrame(measure)
    }

    measure()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll) }
  }, [items])

  function jump(item: OutlineItem) {
    const el = scroller()
    if (!el) return
    const rect = item.el.getBoundingClientRect()
    // A detached heading reports an all-zero rect; scrolling on that would jump to the top.
    if (rect.top === 0 && rect.height === 0) return
    // Rect deltas rather than offsetTop: .vditor-reset is position:static, so a heading's
    // offsetParent is .ink-center and offsetTop would be measured from the wrong origin.
    el.scrollTop += rect.top - el.getBoundingClientRect().top - JUMP_OFFSET
  }

  if (!currentPath.value) {
    return <div class="ink-outline-empty">No file open</div>
  }
  if (items.length === 0) {
    return <div class="ink-outline-empty">No headings in this note</div>
  }

  return (
    <div class="ink-outline" role="tree" aria-label="Outline">
      {items.map((item, i) => (
        <button
          key={`${i}-${item.text}`}
          type="button"
          role="treeitem"
          aria-selected={i === activeIndex}
          class={[
            'ink-outline-row',
            `ink-outline-l${item.level}`,
            i === activeIndex ? 'active' : '',
          ].filter(Boolean).join(' ')}
          title={item.text}
          onClick={() => { jump(item); onJump?.() }}
        >
          {item.text === '' ? <span class="ink-outline-untitled">Untitled</span> : item.text}
        </button>
      ))}
    </div>
  )
}
