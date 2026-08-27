import { useRef } from 'preact/hooks'
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
/**
 * One gesture, one action, and the action happens on the press.
 *
 * Leaving source mode means leaving a focused textarea, and dismissing the keyboard moves
 * everything under the thumb: the press lands on the button, the release lands wherever the button
 * has moved to, and the browser delivers no click at all. Measured on a phone — Source to Edit did
 * nothing until it was tapped a second time. Acting on `pointerdown` settles it before anything can
 * move, and suppressing the default keeps the focus where it is until the mode has changed.
 *
 * `onClick` stays for the keyboard and for anything that activates a button without a pointer; the
 * flag is what stops one press from counting twice.
 */
function usePress(): (run: () => void) => {
  onPointerDown: (e: Event) => void
  onClick: () => void
} {
  const pressed = useRef(false)
  return (run) => ({
    onPointerDown: (e: Event) => {
      e.preventDefault()
      pressed.current = true
      run()
    },
    onClick: () => {
      if (pressed.current) { pressed.current = false; return }
      run()
    },
  })
}

export function PhoneBar() {
  const press = usePress()
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
            {...press(() => { setViewMode(mode) })}
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
        {...press(() => { void flushSave().then(() => refreshGitStatus()) })}
      >
        {dirty.value ? 'Save' : 'Saved'}
      </button>
    </div>
  )
}
