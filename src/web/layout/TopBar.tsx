import { MenuButton } from '../components/Menu.js'
import { openCommit } from '../state/commit.js'
import { gitStatus, pushVault } from '../state/git.js'
import {
  IconAgent,
  IconBack,
  IconCommit,
  IconEditMode,
  IconMore,
  IconOutline,
  IconPushArrow,
  IconReadMode,
  IconRightPanel,
  IconSettings,
  IconSidebar,
  IconSource,
  IconUnsavedDot,
} from '../components/icons.js'
import { dirty } from '../state/document.js'
import { setViewMode, viewMode } from '../state/settings.js'
import {
  isPhone,
  phoneScreen,
  showPhoneList,
  toggleLeftPanel,
  togglePhoneSheet,
  toggleRightPanel,
} from '../state/ui.js'
import { shareMenuItem } from '../share/menuItem.js'
import { currentPath } from '../state/vault.js'

export interface TopBarProps {
  onOpenSettings: () => void
  /**
   * Render the list's bar even though the phone is still on the document.
   *
   * The copy that rides in on a back-swipe needs it: a menu arriving without its own header looks
   * decapitated, and the header underneath belongs to the document being left.
   */
  forceList?: boolean
}

/**
 * The three views, in the order you move between them: editing, then reading it back, then the
 * markup underneath. Each icon names the view it selects rather than the one a click leaves.
 */
const VIEWS = [
  { mode: 'edit' as const, label: 'Edit (Cmd/Ctrl+E)', Icon: IconEditMode },
  { mode: 'read' as const, label: 'Read (Cmd/Ctrl+E)', Icon: IconReadMode },
  { mode: 'source' as const, label: 'Markdown source (Cmd/Ctrl+Alt+M)', Icon: IconSource },
]

export function TopBar({ onOpenSettings, forceList = false }: TopBarProps) {
  const path = currentPath.value
  const view = viewMode.value

  /*
   * The phone's bar carries navigation, not controls: back, what you are looking at, and a menu
   * for the rest. The view control and Save move to the bottom bar, where a thumb reaches; six
   * icons across the top of a 390px screen is neither reachable nor legible.
   */
  if (isPhone.value) {
    // `forceList` is for the copy that rides in on a back-swipe: the phone is still on the
    // document, but the bar arriving with the list has to be the list's own.
    const onList = forceList || phoneScreen.value === 'list'
    return (
      <>
        {onList
          ? <span class="ink-breadcrumb ink-breadcrumb--title">Notes</span>
          : (
            <>
              <button type="button" class="ink-iconbtn" onClick={showPhoneList} title="Back to the list">
                <IconBack />
              </button>
              <span class="ink-breadcrumb">
                {path && dirty.value ? <IconUnsavedDot /> : null}
                {path}
              </span>
            </>
          )}
        <span style={{ marginLeft: 'auto' }} />
        <MenuButton
          label="More"
          triggerClass="ink-iconbtn"
          items={[
            ...(path !== null
              ? [
                { label: 'Outline', icon: <IconOutline />, onSelect: () => { togglePhoneSheet('outline') } },
                { label: 'History', icon: <IconRightPanel />, onSelect: () => { togglePhoneSheet('history') } },
                { label: 'Agent', icon: <IconAgent />, onSelect: () => { togglePhoneSheet('agent') } },
                // Only on a phone. A desktop reaches this from the tree row, which is on screen.
                ...shareMenuItem(path),
              ]
              : []),
            // Git was unreachable on a phone: the bottom bar is the view control and Save, and
            // the footer that carries it on the desktop is not rendered here at all.
            { label: 'Commit…', icon: <IconCommit />, onSelect: () => { void openCommit() } },
            // Push is its own item, not a mode of committing. Shown on the same condition the
            // desktop's push button uses — a remote exists and there is something ahead of it —
            // so it is never offered when it would do nothing, and it names how much it will send.
            ...(gitStatus.value.hasRemote && gitStatus.value.ahead > 0
              ? [{
                label: `Push ${gitStatus.value.ahead}`,
                icon: <IconPushArrow />,
                onSelect: () => { void pushVault() },
              }]
              : []),
            { label: 'Settings', icon: <IconSettings />, onSelect: onOpenSettings },
          ]}
        >
          <IconMore />
        </MenuButton>
      </>
    )
  }

  return (
    <>
      <button type="button" class="ink-iconbtn" onClick={toggleLeftPanel} title="Toggle file tree (Cmd/Ctrl+\)">
        <IconSidebar />
      </button>
      {/* Empty with no file open, rather than "No file open".
          The screen under it is already the empty state — the mark, Recent, and what to start —
          so the words restated what was in plain sight, and the one place they were not visible
          was the phone's list, which says "Notes" and is not empty at all. A breadcrumb names the
          thing you are looking at; with nothing open there is nothing to name. */}
      <span class="ink-breadcrumb">
        {path && dirty.value ? <IconUnsavedDot /> : null}
        {path}
      </span>
      <span style={{ marginLeft: 'auto' }} />

      {/* Edit, read and source are three answers to one question, so they are one control with
          exactly one lit — not three switches that could disagree. Everything in this group acts
          on the open document, so with no document there is nothing here to act on: the group,
          the panel toggle and the word count all go, which is the rule source mode already
          followed on its own. */}
      {path !== null && (
        <>
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
          <button type="button" class="ink-iconbtn" onClick={toggleRightPanel} title="Toggle right panel (Cmd/Ctrl+/)">
            <IconRightPanel />
          </button>
        </>
      )}

      {/* Settings configures the app, not the document, so it sits past the hairline — and stays
          when everything else in this half has gone. The hairline goes with them: a divider with
          nothing on one side of it is just a mark. */}
      {path !== null && <span class="ink-topbar-sep" aria-hidden="true" />}
      <button type="button" class="ink-iconbtn" onClick={onOpenSettings} title="Settings">
        <IconSettings />
      </button>
    </>
  )
}
