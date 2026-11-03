import { IconCalendar } from '../components/icons.js'
import type { MenuItem } from '../components/Menu.js'
import { openFile } from '../state/document.js'
import { currentPath } from '../state/vault.js'
import { startToday } from './today.js'

/**
 * One menu item: start today's entry in a note kept by date.
 *
 * It appears on every note rather than on a configured one. There is no setting for "which note is
 * the journal" because a setting with one value is a question asked twice — the note you press it
 * in is the one you meant.
 */

/** How long to wait for the editor after opening a different note, before giving up quietly. */
const READY_MS = 2000
const STEP_MS = 50

export function todayMenuItem(path: string): MenuItem[] {
  return [{
    label: 'Today',
    icon: <IconCalendar size={15} />,
    onSelect: () => { void todayIn(path) },
  }]
}

/**
 * Today's section in `path`, opening the note first if it is not the one on screen.
 *
 * The wait is a poll rather than a promise because what has to be ready is the *editor*, not the
 * file: `openFile` resolves when the text arrives, and the editor takes it from a signal a moment
 * later. Polling a command that reports whether it could run is honest about that, and it gives up
 * rather than hanging on a note that never opens.
 */
export async function todayIn(path: string): Promise<boolean> {
  if (currentPath.value !== path) await openFile(path)
  for (let waited = 0; waited <= READY_MS; waited += STEP_MS) {
    if (startToday()) return true
    await new Promise((resolve) => setTimeout(resolve, STEP_MS))
  }
  return false
}
