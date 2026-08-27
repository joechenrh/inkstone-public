import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks'
import type { VaultEntry } from '../../shared/types.js'
import { currentPath, isExpanded, toggleDir, startRename, startMove, commitRename, cancelPending, commitCreate, deleteEntry, pendingOp, startCreateIn } from '../state/vault.js'
import { dirty } from '../state/document.js'
import { IconFile, IconFolder, IconMore, IconMove, IconRename, IconTrash, IconUnsavedDot } from '../components/icons.js'
import { MenuButton, type MenuItem } from '../components/Menu.js'
import { shareMenuItem } from '../share/menuItem.js'
import { isAssetPath } from '../assets/paths.js'
import { followLink } from '../editor/note-links.js'
import { notesUsing } from '../state/search.js'

const INDENT_PX = 14

export interface TreeNodeProps {
  entry: VaultEntry
  depth: number
  onOpenFile: (path: string) => void
}

export function TreeNode({ entry, depth, onOpenFile }: TreeNodeProps) {
  const expanded = entry.type === 'dir' && isExpanded(entry.path)
  const selected = currentPath.value === entry.path
  const isCurrentDirty = selected && dirty.value

  const [confirmDelete, setConfirmDelete] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const createInputRef = useRef<HTMLInputElement>(null)

  const op = pendingOp.value
  const isRenaming = op?.kind === 'rename' && op.path === entry.path
  const isCreateTarget =
    entry.type === 'dir' &&
    expanded &&
    op != null &&
    op.kind !== 'rename' &&
    op.parent === entry.path

  // Select-all on rename mount: focus + select existing text so typing replaces it.
  useEffect(() => {
    if (!isRenaming) return
    const input = renameInputRef.current
    if (!input) return
    input.focus()
    /*
     * Renaming selects the name, so the first keystroke replaces it. A move opens the same field on
     * the whole path, where that would mean retyping the file name to change only its folder — so
     * the folder alone is selected, and a note at the root gets an empty selection to type into.
     */
    if (op?.kind === 'rename' && op.whole) {
      // A note at the root has no folder to replace, so the caret goes in front of the name.
      input.setSelectionRange(0, Math.max(input.value.lastIndexOf('/'), 0))
    } else {
      input.select()
    }
  }, [isRenaming])

  /* `autoFocus` is ignored here. The attribute only takes effect while the document's autofocus
     flag is unset, which the login form's password field already consumed, so an input mounted
     later opens unfocused: Escape cancelled nothing and the name had to be clicked into before it
     could be typed. That made Cmd/Alt+N pointless — the whole reason to have a shortcut is not
     touching the pointer. Focus explicitly, in a layout effect so it lands before the paint. */
  useLayoutEffect(() => {
    if (isCreateTarget) createInputRef.current?.focus()
  }, [isCreateTarget])

  // Outside-click cancel: when a pendingOp is active, cancel it if the user
  // clicks outside the relevant inline input (mousedown fires before blur).
  useEffect(() => {
    if (!isRenaming && !isCreateTarget) return

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      const renameEl = renameInputRef.current
      const createEl = createInputRef.current
      if (renameEl && renameEl.contains(target)) return
      if (createEl && createEl.contains(target)) return
      cancelPending()
    }

    document.addEventListener('mousedown', handleMouseDown)
    return () => { document.removeEventListener('mousedown', handleMouseDown) }
  }, [isRenaming, isCreateTarget])

  function handleCreateKeyDown(e: KeyboardEvent) {
    const input = createInputRef.current
    if (!input) return
    if (e.key === 'Enter') {
      e.stopPropagation()
      void commitCreate(input.value)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      cancelPending()
    }
  }

  const handleClick = () => {
    if (isRenaming) return
    if (confirmDelete) return
    if (entry.type === 'dir') { toggleDir(entry.path); return }
    // A picture is not a note. Opening one in the editor reads its bytes as UTF-8 and fills the
    // document with mojibake, or reports `not found` — which is what the folder being hidden was
    // protecting the reader from. It opens in a tab of its own instead, through the same resolver
    // a link in a note goes through.
    if (isAssetPath(entry.path)) { followLink(`/${entry.path}`, null); return }
    onOpenFile(entry.path)
  }

  /**
   * How many notes still refer to this picture, once the confirmation is up.
   *
   * From the copy of the vault's text the search already holds in the browser — no request, no new
   * machinery. Null until it is known; a picture nothing points at is the one you came here to
   * delete, and until now nothing in the application could tell you which those were.
   */
  const [usedBy, setUsedBy] = useState<number | null>(null)
  useEffect(() => {
    if (!confirmDelete || !isAssetPath(entry.path)) { setUsedBy(null); return }
    let live = true
    void notesUsing(entry.name).then((n) => { if (live) setUsedBy(n) })
    return () => { live = false }
  }, [confirmDelete, entry.path, entry.name])

  function handleRenameKeyDown(e: KeyboardEvent) {
    const input = renameInputRef.current
    if (!input) return
    if (e.key === 'Enter') {
      e.stopPropagation()
      void commitRename(input.value)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      cancelPending()
    }
  }

  // Folders can be created into; files cannot. Delete still goes through the row's inline
  // confirmation rather than firing straight from the menu.
  const rowActions: MenuItem[] = [
    ...(entry.type === 'dir'
      ? [
          {
            label: 'New file',
            icon: <IconFile size={15} />,
            onSelect: () => { startCreateIn('create-file', entry.path) },
          },
          {
            label: 'New folder',
            icon: <IconFolder size={15} />,
            onSelect: () => { startCreateIn('create-dir', entry.path) },
          },
        ]
      : []),
    {
      label: 'Rename',
      icon: <IconRename size={15} />,
      onSelect: () => { startRename(entry.path) },
    },
    // Moving is the same edit as renaming, opened on the whole path: the server has always taken
    // two paths and made the destination's parent, so a slash in that field is all it ever needed.
    {
      label: 'Move\u2026',
      icon: <IconMove size={15} />,
      onSelect: () => { startMove(entry.path) },
    },
    // A folder is not a document, so there is nothing to publish; this is also the only entry
    // point a desktop has, since its top bar carries no menu at all.
    ...(entry.type === 'file' ? shareMenuItem(entry.path) : []),
    {
      label: 'Delete',
      icon: <IconTrash size={15} />,
      danger: true,
      onSelect: () => { setConfirmDelete(true) },
    },
  ]

  return (
    <>
      <div
        class={`ink-tree-row${selected ? ' selected' : ''}`}
        style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
        onClick={handleClick}
        role="treeitem"
        aria-expanded={entry.type === 'dir' ? expanded : undefined}
        aria-selected={selected}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleClick()
          }
        }}
      >
        <span class={`ink-tree-caret${entry.type === 'dir' ? (expanded ? ' expanded' : '') : ' empty'}`}>
          {entry.type === 'dir' ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 2l4 3-4 3" />
            </svg>
          ) : null}
        </span>

        {isCurrentDirty && (
          <IconUnsavedDot class="ink-tree-unsaved" />
        )}

        {isRenaming ? (
          <input
            ref={renameInputRef}
            class="ink-tree-inline-input"
            type="text"
            defaultValue={op.initialName}
            onKeyDown={handleRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span class="ink-tree-name">{entry.name}</span>
        )}

        <span class="ink-tree-actions">
          {/* What deleting it would cost, said before it is deleted rather than discovered after.
              Only for a picture: a note's own name is what its worth is judged on. */}
          {confirmDelete && usedBy !== null && (
            <span class={`ink-tree-uses${usedBy === 0 ? ' ink-tree-uses--free' : ''}`}>
              {usedBy === 0 ? 'no note uses it' : `used in ${usedBy} note${usedBy === 1 ? '' : 's'}`}
            </span>
          )}
          {confirmDelete ? (
            <>
              <button
                class="ink-tree-action-btn"
                title="Confirm delete"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmDelete(false)
                  void deleteEntry(entry.path)
                }}
              >
                ✓
              </button>
              <button
                class="ink-tree-action-btn"
                title="Cancel delete"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmDelete(false)
                }}
              >
                ✗
              </button>
            </>
          ) : (
            <MenuButton
              label={`Actions for ${entry.name}`}
              triggerClass="ink-tree-action-btn"
              items={rowActions}
            >
              <IconMore size={16} />
            </MenuButton>
          )}
        </span>
      </div>
      {expanded && (
        <>
          {isCreateTarget && (
            <div
              class="ink-tree-input-row"
              style={{ paddingLeft: `${8 + (depth + 1) * INDENT_PX}px` }}
            >
              <input
                ref={createInputRef}
                class="ink-tree-inline-input"
                type="text"
                onKeyDown={handleCreateKeyDown}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
          {entry.children?.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} onOpenFile={onOpenFile} />
          ))}
        </>
      )}
    </>
  )
}
