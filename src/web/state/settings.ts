import { computed, signal } from '@preact/signals'

const EDITOR_KEY = 'inkstone.editorFontSize'
const READ_ONLY_KEY = 'inkstone.readOnly'
const SHOW_ASSETS_KEY = 'inkstone.showAssets'
const EDITOR_SIZES = [12, 14, 16, 18]

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function safeSet(key: string, v: string): void {
  try { localStorage.setItem(key, v) } catch { /* storage denied — in-memory state still applies */ }
}
function coerce(raw: string | null, allowed: number[], fallback: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10)
  return allowed.includes(n) ? n : fallback
}


export const editorFontSize = signal(coerce(safeGet(EDITOR_KEY), EDITOR_SIZES, 16))

/**
 * Whether the pictures show in the file tree.
 *
 * Off, because they are storage rather than notes: nothing opens one, nothing renames one — the
 * name is the hash of its own bytes — and a screenshot per paste would push the notes off the
 * screen within a week. That holds for the ninety-nine per cent of the time you are writing, and
 * fails exactly once: when you want a picture *gone*. Hidden, it cannot be reached, so it cannot
 * be deleted, and a dead end is a bug.
 *
 * A way in rather than a preference, which is what earns it a row in a window this application
 * keeps trying to shrink.
 */
export const showAssets = signal(safeGet(SHOW_ASSETS_KEY) === '1')

export function setShowAssets(next: boolean): void {
  showAssets.value = next
  // '1'/'0' rather than a removed key: an absent key is indistinguishable from never-set, which is
  // the same thing today and would stop being so if the default ever flipped.
  safeSet(SHOW_ASSETS_KEY, next ? '1' : '0')
}

/**
 * How the open document is being looked at. One of three, never two at once.
 *
 * These were separate switches — a read-only flag and a source-mode flag — which allowed
 * "read-only source", a state neither control described and neither icon showed. They are not
 * independent settings; they are three answers to the same question, so they are one value.
 *
 *   edit    the rendered document, editable
 *   read    the rendered document, not editable, and clicking never expands a block's markers
 *   source  the raw markdown
 *
 * Persisted, because read is a reading posture rather than a per-session accident — but `source`
 * is coerced back to `edit` on load. Source mode is somewhere you go to fix one thing, and
 * starting there after a reload would be a surprise rather than a convenience.
 */
export type ViewMode = 'edit' | 'read' | 'source'

const storedMode = safeGet(READ_ONLY_KEY) === '1' ? 'read' : 'edit'
export const viewMode = signal<ViewMode>(storedMode)

export const readOnly = computed(() => viewMode.value === 'read')
export const sourceMode = computed(() => viewMode.value === 'source')

export function setViewMode(mode: ViewMode): void {
  viewMode.value = mode
  // Only the reading posture is remembered; see above.
  safeSet(READ_ONLY_KEY, mode === 'read' ? '1' : '0')
}

export function setReadOnly(on: boolean): void {
  setViewMode(on ? 'read' : 'edit')
}

/** Cmd/Ctrl+E. From source, this lands on read — the key asks for reading, not for going back. */
export function toggleReadOnly(): void {
  setViewMode(viewMode.value === 'read' ? 'edit' : 'read')
}

/** Cmd/Ctrl+Alt+M. Leaving source returns to editing, which is where it was entered from. */
export function toggleSourceMode(): void {
  setViewMode(viewMode.value === 'source' ? 'edit' : 'source')
}

export function setEditorFontSize(px: number): void {
  editorFontSize.value = px
  document.documentElement.style.setProperty('--ink-font-size', `${px}px`)
  safeSet(EDITOR_KEY, String(px))
}

export function initSettings(): void {
  setEditorFontSize(coerce(safeGet(EDITOR_KEY), EDITOR_SIZES, 16))
}
