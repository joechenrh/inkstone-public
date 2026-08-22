import { flushSave, goBack, goForward } from './document.js'
import { toggleReadOnly, toggleSourceMode } from './settings.js'
import { refreshGitStatus } from './git.js'
import { setSidebarView, toggleLeftPanel, toggleRightPanel } from './ui.js'
import { beginCreate } from './vault.js'

/**
 * All global keyboard shortcuts, in one testable function.
 *
 * Returns true when the event was handled, in which case preventDefault has been called.
 */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false

  // Creating things is on Alt, because the conventional keys are not ours to take: the browser
  // keeps Cmd+N for a new window and Shift+Cmd+N for an incognito one, and neither event ever
  // reaches the page. Matched on `e.code`, not `e.key`: holding Option on macOS rewrites `key`
  // to the composed character, so Cmd+Alt+N can arrive as "˜".
  if (e.altKey) {
    switch (e.code) {
      case 'KeyN':
        beginCreate('create-file')
        break
      case 'KeyF':
        beginCreate('create-dir')
        break
      // M for markdown. Typora's is Cmd+/, which here already toggles the history drawer, and
      // churning a key that works to match another app is the wrong trade.
      case 'KeyM':
        toggleSourceMode()
        break
      // Everything else on Ctrl/Cmd+Alt belongs to Vditor — digits 1-6 set the heading level
      // and 7-9 switch edit mode — so it has to pass through untouched.
      default:
        return false
    }
    e.preventDefault()
    return true
  }

  switch (e.key) {
    case '\\':
      toggleLeftPanel()
      break
    case '/':
      toggleRightPanel()
      break
    case '1':
      setSidebarView('files')
      break
    case '2':
      setSidebarView('outline')
      break
    case 'e':
    case 'E':
      toggleReadOnly()
      break
    case 's':
    case 'S':
      void flushSave().then(() => { void refreshGitStatus() })
      break
    // Back and forward through the notes visited this session — Typora's binding. Following a link
    // between notes is otherwise a one-way door, and a dead end is a bug rather than a missing
    // button. The browser's own Back is not spent on this: it belongs to the routes the application
    // really has, and it would then mean two different things depending on how you arrived.
    case '[':
      void goBack()
      break
    case ']':
      void goForward()
      break
    default:
      return false
  }
  e.preventDefault()
  return true
}
