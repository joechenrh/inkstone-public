import { openFile } from '../state/document.js'
import { recentPaths } from '../state/recent.js'
import { beginCreate, tree } from '../state/vault.js'
import './empty-state.css'

/** "notes/deep/file.md" → { name: "file.md", where: "notes / deep" } */
function split(path: string): { name: string; where: string } {
  const parts = path.split('/')
  const name = parts.pop() ?? path
  return { name, where: parts.length ? parts.join(' / ') : 'Vault root' }
}

/**
 * An action, written the way VSCode's welcome writes one: the name on the left, the keys that do
 * the same thing on the right.
 *
 * The keycap is the point — this is the screen you look at when nothing is open, so it is the one
 * chance to teach the shortcut. Which means the chip has to be true: every one here is a key
 * `handleShortcut` actually implements, and a row without a working key gets no chip.
 */
function ActionRow(
  { label, keys, onClick }: { label: string; keys: string[]; onClick: () => void },
) {
  return (
    <li>
      <button type="button" class="ink-empty-item ink-empty-action" onClick={onClick}>
        <span class="ink-empty-name">{label}</span>
        <span class="ink-empty-where">
          {keys.map((k) => <kbd key={k}>{k}</kbd>)}
        </span>
      </button>
    </li>
  )
}

/**
 * Cmd+Alt rather than Cmd+N, which the browser keeps for a new window and never delivers.
 *
 * Rendered as the platform's own glyphs: ⌘⌥ on a Mac, Ctrl+Alt everywhere else. Showing a Mac
 * keycap to someone pressing Ctrl is the same lie as showing a key that does nothing.
 */
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const MOD = isMac ? ['⌘', '⌥'] : ['Ctrl', 'Alt']

function Actions() {
  return (
    <ul class="ink-empty-recent">
      <ActionRow label="New note" keys={[...MOD, 'N']} onClick={() => { beginCreate('create-file') }} />
      <ActionRow label="New folder" keys={[...MOD, 'F']} onClick={() => { beginCreate('create-dir') }} />
    </ul>
  )
}

/**
 * What the editor column shows with no file open.
 *
 * Borrowed from VSCode's welcome screen: a faint wordmark over rows of name-and-keys, and no
 * buttons anywhere. The two groups stay labelled — a note you opened yesterday and a thing you can
 * do now are not the same kind of line, and without the second eyebrow they read as one list.
 *
 * Two states rather than three: the actions are the same either way, so an empty vault no longer
 * needs its own arrangement — it simply has no Recent group above them.
 */
export function EmptyState() {
  const recent = recentPaths.value
  // Null means nobody has looked yet, which is not the same as empty.
  const vaultIsEmpty = tree.value?.length === 0

  return (
    <div class="ink-empty" role="region" aria-label="No file open">
      <div class="ink-empty-card">
        <span class="ink-empty-mark" aria-hidden="true">Inkstone</span>

        {recent.length > 0 && (
          <>
            <span class="ink-empty-eyebrow">Recent</span>
            <ul class="ink-empty-recent">
              {recent.map((path) => {
                const { name, where } = split(path)
                return (
                  <li key={path}>
                    <button type="button" class="ink-empty-item" onClick={() => { void openFile(path) }}>
                      <span class="ink-empty-name">{name}</span>
                      <span class="ink-empty-where">{where}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <span class="ink-empty-eyebrow">Start</span>
        <Actions />

        {/* Only when there is nothing on the left to pick either: telling someone with a full
            sidebar to make their first note is wrong, and telling someone with an empty vault to
            choose a note from it is pointing at nothing. */}
        {vaultIsEmpty && recent.length === 0 && (
          <span class="ink-empty-line">This vault is empty.</span>
        )}
      </div>
    </div>
  )
}
