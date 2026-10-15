import { IconUsers } from '../components/icons.js'
import type { MenuItem } from '../components/Menu.js'
import { liveAvailable, livePeers, liveSession, openLivePanel } from '../state/live.js'

/**
 * One menu item, carrying the session's own state — the same arrangement sharing uses.
 *
 * Absent where there is nothing to offer: a deployment that did not ask for live collaboration.
 * An item that leads nowhere is worse than no item.
 *
 * While a session is running, every note's menu says so and leads to the same panel, because the
 * session is the application's state rather than that row's: there is one at a time, and finding it
 * again should not require remembering which note it was.
 */
export function liveMenuItem(path: string, title: string): MenuItem[] {
  if (!liveAvailable.value) return []

  const session = liveSession.value
  if (session === null) {
    return [{
      label: 'Live share…',
      icon: <IconUsers size={15} />,
      onSelect: () => { openLivePanel(path, title) },
    }]
  }

  // Everyone but us. The owner is in the room too, and "1 person" with nobody there reads wrong.
  const others = Math.max(0, livePeers.value.length - 1)
  const mine = session.path === path
  return [{
    label: mine
      ? `协作中 · ${others} 人`
      : `协作中 · ${session.title}`,
    icon: <IconUsers size={15} />,
    onSelect: () => { openLivePanel(session.path, session.title) },
  }]
}
