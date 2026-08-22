import type { ComponentChildren, JSX } from 'preact'
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import './menu.css'

export interface MenuItem {
  label: string
  icon: JSX.Element
  /** Renders in the danger colour. Destructive items only. */
  danger?: boolean
  /** Renders in the warning colour. For an item whose own label is the warning. */
  warn?: boolean
  onSelect: () => void
}

export interface MenuButtonProps {
  items: MenuItem[]
  /** Accessible name for the trigger, which only contains an icon. */
  label: string
  triggerClass?: string
  children: ComponentChildren
}

/**
 * An icon trigger that opens a popover menu.
 *
 * The popover is `position: fixed`, positioned from the trigger's rect. It has to be: the
 * sidebar clips (`.ink-left` is overflow:hidden and `.ink-sidebar-view` scrolls), so an
 * absolutely-positioned popover would be cut off at the row it belongs to. A fixed element's
 * containing block is the viewport, so it escapes both.
 *
 * The trade-off is that a fixed popover cannot follow its anchor, so any scroll closes it
 * rather than letting it drift away from the row it describes.
 */
export function MenuButton({ items, label, triggerClass, children }: MenuButtonProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, right: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  function toggle(e: MouseEvent) {
    // The row underneath opens a file on click; the trigger must not reach it.
    e.stopPropagation()
    const el = triggerRef.current
    if (!el) return
    if (open) { setOpen(false); return }
    const r = el.getBoundingClientRect()
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) })
    setOpen(true)
  }

  /**
   * Escape and arrow handling. Bound both to the menu element and to the document: the menu
   * binding is what actually fires while focus is inside the popover, and the document
   * binding covers the case where focus has moved elsewhere.
   */
  function handleKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return
    ev.preventDefault()
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('.ink-menu-item') ?? [],
    )
    if (buttons.length === 0) return
    const here = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = ev.key === 'ArrowDown'
      ? (here + 1) % buttons.length
      : (here - 1 + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  const onMenuKeyDown = (ev: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    handleKey(ev as unknown as KeyboardEvent)
  }

  // Layout, not plain effect. A plain effect runs after paint, which leaves a window where the
  // menu is on screen but focus is still on the trigger and no key listener is bound yet — an
  // Escape landing in it hits the trigger, outside the menu, and is dropped. It is wide enough
  // to lose roughly half of the presses that immediately follow the click.
  useLayoutEffect(() => {
    if (!open) return

    menuRef.current?.querySelector<HTMLButtonElement>('.ink-menu-item')?.focus()

    const onPointerDown = (ev: MouseEvent) => {
      const t = ev.target as Node | null
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }

    const onKey = handleKey

    const close = () => { setOpen(false) }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    // Capture phase so a scroll in any ancestor closes it, not just the document.
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        class={triggerClass}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        {children}
      </button>
      {open && (
        <div
          ref={menuRef}
          class="ink-menu"
          role="menu"
          // No aria-label here: it would duplicate the trigger's accessible name, so a
          // by-name query would match two elements.
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          style={{ top: `${pos.top}px`, right: `${pos.right}px` }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              class={`ink-menu-item${item.danger ? ' danger' : ''}${item.warn ? ' warn' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
                item.onSelect()
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
