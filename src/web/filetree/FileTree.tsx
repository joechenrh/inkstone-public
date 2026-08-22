import { useRef, useEffect, useLayoutEffect } from 'preact/hooks'
import { cancelPending, commitCreate, pendingOp, tree } from '../state/vault.js'
import './filetree.css'
import { TreeNode } from './TreeNode.js'
import { NewEntryButton } from '../layout/Sidebar.js'
import { isPhone } from '../state/ui.js'
import { usePendingPlaceholder } from '../state/pending.js'
import { SearchField } from './SearchField.js'
import { SearchResults } from './SearchResults.js'
import { openAtMatch, searchQuery } from '../state/search.js'
import { showAssets } from '../state/settings.js'
import { ASSET_DIR } from '../assets/paths.js'

export interface FileTreeProps {
  onOpenFile: (path: string) => void
}

export function FileTree({ onOpenFile }: FileTreeProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const op = pendingOp.value

  function handleCreateKeyDown(e: KeyboardEvent) {
    const input = inputRef.current
    if (!input) return
    if (e.key === 'Enter') {
      void commitCreate(input.value)
    } else if (e.key === 'Escape') {
      cancelPending()
    }
  }

  const showRootCreate = op && op.kind !== 'rename' && op.parent === ''

  /* `autoFocus` is ignored here. The attribute only takes effect while the document's autofocus
     flag is unset, which the login form's password field already consumed, so an input mounted
     later opens unfocused: Escape cancelled nothing and the name had to be clicked into before it
     could be typed. That made Cmd/Alt+N pointless — the whole reason to have a shortcut is not
     touching the pointer. Focus explicitly, in a layout effect so it lands before the paint. */
  useLayoutEffect(() => {
    if (showRootCreate) inputRef.current?.focus()
  }, [showRootCreate])

  // Outside-click cancel for root-level inline input
  useEffect(() => {
    if (!showRootCreate) return

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      const inputEl = inputRef.current
      if (inputEl && inputEl.contains(target)) return
      cancelPending()
    }

    document.addEventListener('mousedown', handleMouseDown)
    return () => { document.removeEventListener('mousedown', handleMouseDown) }
  }, [showRootCreate])

  // Nothing at all for the first fraction of a second: a tree that arrives quickly should
  // replace an empty column, not a placeholder that was up for two frames.
  const loading = usePendingPlaceholder(tree.value === null)

  // Anything typed replaces the tree with results — both depths at once, so there is no state
  // where a name has matched and what is written about it is still unknown.
  const showingResults = searchQuery.value.trim() !== ''

  return (
    <div class="ink-tree-container">
      {/* On a phone there is no switcher for the + to sit in, so it joins the row that already
          acts on this list. On a desktop it stays where it was, beside the two tabs. */}
      {isPhone.value ? (
        <div class="ink-tree-searchrow">
          <SearchField />
          <NewEntryButton triggerClass="ink-tree-add" />
        </div>
      ) : <SearchField />}

      {showingResults ? (
        <SearchResults
          onOpen={(path) => {
            void openAtMatch(path, searchQuery.value, async (p) => { onOpenFile(p) })
          }}
        />
      ) : (
        <>
      {showRootCreate && (
        <div class="ink-tree-input-row">
          <input
            ref={inputRef}
            class="ink-tree-inline-input"
            type="text"
            onKeyDown={handleCreateKeyDown}
          />
        </div>
      )}

      {/* Three states, not two. Null is "nobody has looked yet" and says nothing about the
          vault; only an actual empty array claims there is nothing in it. */}
      {tree.value === null
        ? (loading && <TreeSkeleton />)
        : tree.value.length === 0 && !showRootCreate
          ? <div class="ink-tree-empty">No notes yet</div>
          : (
            <div class="ink-tree" role="tree">
              {/* The pictures are storage rather than notes and are hidden by default — see
                  `settings.ts`. Hidden here rather than at the server, so the switch can bring
                  them back: a tree that never sent them could not. */}
              {tree.value
                .filter((entry) => showAssets.value || entry.path !== ASSET_DIR)
                .map((entry) => (
                  <TreeNode key={entry.path} entry={entry} depth={0} onOpenFile={onOpenFile} />
                ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Rows in the shape rows take, indents included.
 *
 * Not a spinner: a spinner says something is happening somewhere, and this says what is coming
 * and where it will be.
 */
function TreeSkeleton() {
  const rows = [0, 1, 1, 0, 1, 0]
  return (
    <div class="ink-tree-skeleton" aria-hidden="true">
      {rows.map((depth, i) => (
        <div key={i} class="ink-tree-skeleton-row" style={{ marginLeft: `${12 + depth * 14}px` }} />
      ))}
    </div>
  )
}
