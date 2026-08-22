import { IconFile, IconFiles, IconFolder, IconOutline, IconPlus } from '../components/icons.js'
import { MenuButton } from '../components/Menu.js'
import { FileTree } from '../filetree/FileTree.js'
import { OutlinePanel } from '../outline/OutlinePanel.js'
import { isPhone, setSidebarView, sidebarView } from '../state/ui.js'
import { startCreate } from '../state/vault.js'

export interface SidebarProps {
  onOpenFile: (path: string) => void
}

/**
 * Creating at the vault root.
 *
 * It switches to the file view first, because the inline name input it opens lives in the tree
 * and would otherwise be invisible.
 */
export function NewEntryButton({ triggerClass }: { triggerClass: string }) {
  return (
    <MenuButton
      label="New"
      triggerClass={triggerClass}
      items={[
        {
          label: 'New file',
          icon: <IconFile size={15} />,
          onSelect: () => { setSidebarView('files'); startCreate('create-file') },
        },
        {
          label: 'New folder',
          icon: <IconFolder size={15} />,
          onSelect: () => { setSidebarView('files'); startCreate('create-dir') },
        },
      ]}
    >
      <IconPlus size={16} />
    </MenuButton>
  )
}

/**
 * The left sidebar: on a desktop, a switcher and one of two views.
 *
 * Only one view is visible at a time so each gets the full column — headings are not
 * truncated and the tree is not compressed. `Cmd/Ctrl+1` and `Cmd/Ctrl+2` switch without
 * reaching for the mouse (see state/shortcuts.ts).
 *
 * **A phone has neither the switcher nor the outline.** It cannot: the outline reads headings out
 * of the editor, and on the phone's list screen the editor is not mounted at all — the sidebar is
 * rendered *instead of* the document. The panel found nothing every time and reported it as "No
 * headings in this note", which is a false statement about a note that is not there. The outline
 * already has a home on the phone that works, as a sheet over the document.
 *
 * The stored view is deliberately ignored rather than reset, so narrowing the window while on the
 * outline does not strand anyone on a panel with no way off, and widening it again restores what
 * they had chosen.
 *
 * The git controls are not here: they live in the status bar so they stay in one fixed place
 * whether or not the sidebar is open.
 */
export function Sidebar({ onOpenFile }: SidebarProps) {
  const view = isPhone.value ? 'files' : sidebarView.value

  if (isPhone.value) {
    return (
      <div class="ink-sidebar">
        <div class="ink-sidebar-view">
          <FileTree onOpenFile={onOpenFile} />
        </div>
      </div>
    )
  }

  return (
    <div class="ink-sidebar">
      <div class="ink-sidebar-switch">
        <button
          type="button"
          class="ink-sidebar-tab"
          aria-pressed={view === 'files'}
          onClick={() => setSidebarView('files')}
        >
          <IconFiles size={15} />
          Files
        </button>
        <button
          type="button"
          class="ink-sidebar-tab"
          aria-pressed={view === 'outline'}
          onClick={() => setSidebarView('outline')}
        >
          <IconOutline size={15} />
          Outline
        </button>
        <NewEntryButton triggerClass="ink-sidebar-add" />
      </div>
      <div class="ink-sidebar-view">
        {view === 'files' ? <FileTree onOpenFile={onOpenFile} /> : <OutlinePanel />}
      </div>
    </div>
  )
}
