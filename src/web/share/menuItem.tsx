import { hasIdentity } from '../auth/identity.js'
import { IconShare } from '../components/icons.js'
import type { MenuItem } from '../components/Menu.js'
import { daysLeft, openSharePanel, sharedByPath, sharingAvailable } from '../state/share.js'

/** Under this the label takes the warning colour. That is the entire notification system. */
const NEARLY_GONE_DAYS = 3

/**
 * One menu item, carrying the note's own state.
 *
 * The same item goes in two menus: a tree row's, which acts on that row's note at both sizes, and
 * the phone's top bar, which acts on the open one — because on a phone the tree is a different
 * screen, and walking back to find the note you are reading is the trip History exists to avoid.
 *
 * Null when there is nothing to offer: a deployment with no share store, or a vault with no GitHub
 * account to attribute a share to. An item that leads to a 404 is worse than no item.
 */
export function shareMenuItem(path: string): MenuItem[] {
  if (!sharingAvailable.value || !hasIdentity()) return []

  const record = sharedByPath.value[path]
  if (record === undefined) {
    return [{ label: 'Share…', icon: <IconShare size={15} />, onSelect: () => { openSharePanel(path) } }]
  }

  const left = daysLeft(record.expiresAt)
  return [{
    // The state is the label. There is no second item, no badge and no dot.
    label: `Shared · ${left} ${left === 1 ? 'day' : 'days'} left`,
    icon: <IconShare size={15} />,
    warn: left < NEARLY_GONE_DAYS,
    onSelect: () => { openSharePanel(path) },
  }]
}
