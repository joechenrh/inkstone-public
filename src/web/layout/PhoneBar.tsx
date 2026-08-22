import { PictureButton } from '../assets/PictureButton.js'
import { IconEditMode, IconReadMode, IconSource } from '../components/icons.js'
import { dirty, flushSave } from '../state/document.js'
import { refreshGitStatus } from '../state/git.js'
import { setViewMode, viewMode } from '../state/settings.js'
import { phoneScreen } from '../state/ui.js'
import { currentPath } from '../state/vault.js'
import { GitNotice } from './GitNotice.js'
import './phonebar.css'

const VIEWS = [
  { mode: 'edit' as const, label: 'Edit', Icon: IconEditMode },
  { mode: 'read' as const, label: 'Read', Icon: IconReadMode },
  { mode: 'source' as const, label: 'Source', Icon: IconSource },
]

/**
 * The phone's bottom bar: the view control and Save.
 *
 * These are at the bottom because that is where a thumb is. Everything the desktop puts in the
 * top-right either lives here or in the top bar's menu; nothing new was invented for the phone,
 * and the view control is the same three-value setting the desktop shows.
 *
 * Save is a button because there is no Ctrl+S on a phone, and manual save is the app's whole
 * protocol — without a visible one the only route to disk would be the five-minute autocommit.
 */
export function PhoneBar() {
  const path = currentPath.value
  // Only where there is a document to act on. The list is a different screen, and Edit / Read /
  // Source / Save belong to a note you are looking at — on the list they described one you had
  // left, and they stayed under the arriving menu for the length of every back-swipe.
  if (path === null || phoneScreen.value !== 'document') return null
  const view = viewMode.value

  return (
    <div class="ink-phonebar">
      {/* Positioned against this bar, which is the only fixed thing at the bottom of a phone. */}
      <GitNotice />
      <div class="ink-viewgroup" role="group" aria-label="View">
        {VIEWS.map(({ mode, label, Icon }) => (
          <button
            key={mode}
            type="button"
            class={`ink-iconbtn ink-viewbtn${view === mode ? ' on' : ''}`}
            onClick={() => { setViewMode(mode) }}
            aria-pressed={view === mode}
            title={label}
          >
            <Icon />
          </button>
        ))}
      </div>

      {/* Only where there is a caret to put one in. Read mode has none, and source mode is a
          textarea — a control that does nothing is worse than one that is not there. */}
      {view === 'edit' && <PictureButton />}

      <button
        type="button"
        class="ink-phonebar-save"
        // Disabled when there is nothing to write, so the button reports the document's state
        // as well as acting on it — the unsaved dot in the top bar says the same thing.
        disabled={!dirty.value}
        onClick={() => { void flushSave().then(() => refreshGitStatus()) }}
      >
        {dirty.value ? 'Save' : 'Saved'}
      </button>
    </div>
  )
}
