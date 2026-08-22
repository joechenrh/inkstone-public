import { useEffect } from 'preact/hooks'
import { backend } from './api/index.js'
import { ConflictBar } from './components/ConflictBar.js'
import { SaveErrorBar } from './components/SaveErrorBar.js'
import { SettingsModal } from './components/SettingsModal.js'
import { DocumentSkeleton } from './editor/DocumentSkeleton.js'
import { EmptyState } from './editor/EmptyState.js'
import { SourceEditor } from './editor/SourceEditor.js'
import { PhoneBar } from './layout/PhoneBar.js'
import { PhoneSheet } from './layout/PhoneSheet.js'
import { CommitPanel } from './git/CommitPanel.js'
import { SharePanel } from './share/SharePanel.js'
import { CrepeEditor } from './editor/CrepeEditor.js'
import { VditorEditor } from './editor/VditorEditor.js'
import { Sidebar } from './layout/Sidebar.js'
import { RightPanel } from './layout/RightPanel.js'
import { Shell } from './layout/Shell.js'
import { StatusBar } from './layout/StatusBar.js'
import { TopBar } from './layout/TopBar.js'
import { content, dirty, handleExternalChange, openFile } from './state/document.js'
import { gitStatus, refreshGitStatus } from './state/git.js'
import { GitFooter } from './layout/GitFooter.js'
import { handleShortcut } from './state/shortcuts.js'
import { isPhone, openSettings } from './state/ui.js'
import { editorEngine, sourceMode } from './state/settings.js'
import { loadShares } from './state/share.js'
import { currentPath, refreshTree } from './state/vault.js'

function countWords(text: string): number {
  // Mixed CJK/Latin text: count CJK per character, tokenize Latin by whitespace
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g)?.length ?? 0
  const latin = text.replace(/[\u4e00-\u9fff\u3040-\u30ff]/g, ' ').trim()
  return cjk + (latin ? latin.split(/\s+/).length : 0)
}

export function App() {
  useEffect(() => {
    void refreshTree()
    void refreshGitStatus()
    // Which notes are already shared, so the menu can say so without a request per row. A silent
    // no-op unless this deployment offers sharing at all.
    void loadShares()

    const disconnect = backend.connect({
      onEvent: (event) => {
        if (event.type === 'tree-changed') void refreshTree()
        else if (event.type === 'file-changed') {
          void handleExternalChange(event.path, event.rev)
        } else if (event.type === 'git-status') {
          gitStatus.value = event.status
        }
      },
      onReconnect: () => {
        // Events during the disconnect are permanently lost, so after reconnecting we must re-align the full state
        void refreshTree()
        void refreshGitStatus()
        const path = currentPath.value
        if (path) void backend.readFile(path).then((f) => handleExternalChange(path, f.rev))
      },
    })

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.value) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', onBeforeUnload)

    const onKey = (e: KeyboardEvent) => { handleShortcut(e) }
    window.addEventListener('keydown', onKey)

    return () => {
      disconnect()
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // The tab title tracks the open file so several notes open in different tabs stay
  // distinguishable; the leading dot mirrors the breadcrumb's unsaved marker.
  useEffect(() => {
    const name = currentPath.value?.split('/').pop()
    document.title = name ? `${dirty.value ? '• ' : ''}${name}` : 'Inkstone'
  }, [currentPath.value, dirty.value])

  return (
    <>
    <SettingsModal />
    {/* Over everything, and only on a phone — the desktop has the outline beside the document. */}
    {isPhone.value && <PhoneSheet />}
    <CommitPanel />
    <SharePanel />
    <Shell
      topBar={<TopBar onOpenSettings={openSettings} />}
      listTopBar={<TopBar onOpenSettings={openSettings} forceList />}
      left={<Sidebar onOpenFile={(path) => void openFile(path)} />}
      center={
        <>
          <ConflictBar />
          <SaveErrorBar />
          {editorEngine.value === 'crepe' ? <CrepeEditor /> : <VditorEditor />}
          {/* Over the editor, not instead of it — VditorEditor stays mounted so opening a note
              does not rebuild the whole Vditor instance. */}
          {currentPath.value === null && <EmptyState />}
          {/* And over it while a note is on its way: the name is already right, the body is not
              here yet, and after 180ms this says what shape it will be. */}
          <DocumentSkeleton />
          {/* Over the editor for the same reason, and only with a file open — there is no source
              for no document. */}
          {currentPath.value !== null && sourceMode.value && <SourceEditor />}
        </>
      }
      right={<RightPanel />}
      statusBar={isPhone.value ? <PhoneBar /> : (
        <>
          {/* Only with a document: "0 words 0 chars" beside an empty editor is a measurement of
              nothing. The git state stays either way — it describes the vault, not the file. */}
          {currentPath.value !== null && (
            <StatusBar
              words={countWords(content.value)}
              chars={content.value.length}
            />
          )}
          {/* Pinned to the bottom-right, independent of the sidebar: collapsing the sidebar
              must not take the branch, dirty dot, commit and push with it. */}
          <GitFooter />
        </>
      )}
    />
    </>
  )
}
