import { signal } from '@preact/signals'
import { applyDocTheme, clampAppearance, readDocTheme } from './docThemes.js'
import { safeGetItem, safeSetItem } from './storage.js'

export { safeGetItem, safeSetItem }

export type Theme = 'light' | 'dark'
export type ThemeChoice = 'system' | 'light' | 'dark'

// KEY SYNC: This key is also hardcoded in the pre-paint inline script in index.html.
// If you rename it here, update index.html too — there is no import bridge between them.
export const THEME_STORAGE_KEY = 'inkstone.theme'


// Module-level listener reference so we can remove it when switching away from 'system'.
let systemListener: ((e: MediaQueryListEvent) => void) | null = null

/**
 * Return the stored three-state theme choice, defaulting to 'system'.
 *
 * PRECEDENCE SYNC: The inline script in index.html mirrors the resolution logic
 * (stored → OS matchMedia → light) to avoid FOUC. Keep both in lock-step.
 */
export function readThemeChoice(): ThemeChoice {
  const raw = safeGetItem(THEME_STORAGE_KEY)
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}

/** Resolve a ThemeChoice to an actual 'light' | 'dark' value by consulting matchMedia. */
function resolve(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'system') {
    try {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  }
  return choice
}

/**
 * Reactive signal of the currently-resolved theme ('light' | 'dark').
 * Updated in lock-step with every data-theme stamp so consumers (e.g. VditorEditor)
 * can subscribe without polling the DOM.
 */
export const resolvedTheme = signal<'light' | 'dark'>(clampAppearance(readDocTheme(), resolve(readThemeChoice())))

/**
 * Persist the choice, stamp data-theme on <html>, and wire up (or tear down) a
 * matchMedia change listener so 'system' tracks OS changes dynamically.
 */
/**
 * Every colour token changes at once when the appearance flips, and anything with a transition
 * animates through the change — the selected file row sweeps from #e9ebef to #2f3542 over 120ms,
 * which reads as a flash of pale grey across a dark sidebar. Transitions are suppressed for the
 * frame the swap happens in, then restored.
 */
function withoutTransitions(swap: () => void): void {
  const root = document.documentElement
  root.classList.add('ink-theme-switching')
  swap()
  // Reading a layout property flushes the styles above before the class is dropped; without it the
  // browser can coalesce add and remove into one frame and animate anyway.
  void root.offsetHeight
  requestAnimationFrame(() => { root.classList.remove('ink-theme-switching') })
}

export function applyThemeChoice(choice: ThemeChoice): void {
  safeSetItem(THEME_STORAGE_KEY, choice)
  // The document theme has the last word: a theme that only ships one appearance cannot show the
  // other, and forcing it would leave a dark shell around a white page.
  const resolved = clampAppearance(readDocTheme(), resolve(choice))
  withoutTransitions(() => {
    document.documentElement.setAttribute('data-theme', resolved)
  })
  resolvedTheme.value = resolved

  // Tear down any existing OS-tracking listener before potentially creating a new one.
  const mql = (() => {
    try { return window.matchMedia?.('(prefers-color-scheme: dark)') } catch { return null }
  })()
  if (systemListener && mql) {
    mql.removeEventListener('change', systemListener)
  }
  systemListener = null

  if (choice === 'system' && mql) {
    systemListener = () => {
      const next = clampAppearance(readDocTheme(), resolve('system'))
      document.documentElement.setAttribute('data-theme', next)
      resolvedTheme.value = next
    }
    mql.addEventListener('change', systemListener)
  }
}

// ---------------------------------------------------------------------------
// Phase 0 compat: two-state API (kept for existing callers and tests)
// ---------------------------------------------------------------------------

/**
 * Return the stored theme, falling back to:
 *  1. The OS-level prefers-color-scheme (when available), so first-time visitors
 *     get the right default without any user action.
 *  2. 'light' if the media query is also unavailable (e.g. server-side or legacy UA).
 *
 * An explicit user choice written by applyTheme() always wins over the OS default
 * because it is stored and therefore read back before the OS query is consulted.
 *
 * PRECEDENCE SYNC: The inline script in index.html mirrors this exact precedence
 * (stored → OS matchMedia → light) to avoid FOUC. Keep both in lock-step.
 */
export function readStoredTheme(): Theme {
  const raw = safeGetItem(THEME_STORAGE_KEY)
  if (raw === 'dark' || raw === 'light') return raw

  // No stored preference — honour the OS.
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
  } catch {
    // matchMedia can throw in some environments; fall through to default.
  }

  return 'light'
}

/**
 * Stamp data-theme on the root element and persist the choice.
 * Sets the DOM attribute even if localStorage is unavailable, so the
 * visual state is always consistent within the current session.
 */
export function applyTheme(next: Theme): void {
  document.documentElement.setAttribute('data-theme', next)
  safeSetItem(THEME_STORAGE_KEY, next)
}

/**
 * Switch document theme, then re-resolve the appearance against it.
 *
 * The two are not independent: a theme that only ships one appearance overrides the choice, so
 * changing the theme can change the resolved appearance without the user touching it. Applying the
 * theme alone left `data-theme` on its previous value — a dark-only theme with a light `data-theme`
 * meant every dark-scoped rule, and Vditor's own chrome, stayed light inside a dark page.
 */
export function selectDocTheme(id: string): void {
  applyDocTheme(id)
  applyThemeChoice(readThemeChoice())
}
