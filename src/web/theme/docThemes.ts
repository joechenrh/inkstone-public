import { signal } from '@preact/signals'
import { safeGetItem, safeSetItem } from './storage.js'
import type { Theme } from './useTheme.js'

export const DOC_THEME_KEY = 'inkstone.docTheme'

export interface DocTheme {
  id: string
  name: string
  /**
   * Which appearances this theme actually provides.
   *
   * Not a setting — a property of the theme. Typora themes ship one fixed look per file
   * (`lapis.css` and `lapis-dark.css` are two files; Drake is twelve), so an imported theme
   * commonly has exactly one. Built-in themes are written with both.
   */
  appearances: Theme[]
  /** One-line description, shown under the swatch. */
  note: string
}

export const DOC_THEMES: DocTheme[] = [
  { id: 'lapis', name: 'Lapis', appearances: ['light', 'dark'], note: 'Serif headings, blue accent' },
  { id: 'plain', name: 'Plain', appearances: ['light', 'dark'], note: 'Flat sans, hairlines, denser' },
  { id: 'aspartate', name: 'Aspartate', appearances: ['dark'], note: 'Dark, from the Typora theme' },
  { id: 'forest', name: 'Forest', appearances: ['light'], note: 'From the Typora theme' },
  { id: 'tailwind', name: 'Tailwind', appearances: ['light', 'dark'], note: 'From the Typora theme' },
  { id: 'everforest', name: 'Everforest', appearances: ['light', 'dark'], note: 'From the Typora theme' },
  { id: 'bitclean', name: 'BitClean', appearances: ['light', 'dark'], note: 'From the Typora theme' },
]

export const DEFAULT_DOC_THEME = 'lapis'

export function findDocTheme(id: string): DocTheme {
  return DOC_THEMES.find((t) => t.id === id) ?? DOC_THEMES[0]!
}

export function readDocTheme(): string {
  const raw = safeGetItem(DOC_THEME_KEY)
  return raw !== null && DOC_THEMES.some((t) => t.id === raw) ? raw : DEFAULT_DOC_THEME
}

export const docTheme = signal<string>(readDocTheme())

/**
 * The appearance a theme can actually show, given what the user asked for.
 *
 * A single-appearance theme wins: choosing "dark" while a light-only theme is active would
 * otherwise leave the shell dark and the page white, which is the seam the whole
 * chrome-follows-the-theme decision exists to avoid.
 */
export function clampAppearance(themeId: string, wanted: Theme): Theme {
  const { appearances } = findDocTheme(themeId)
  return appearances.includes(wanted) ? wanted : appearances[0]!
}

/** True when the theme offers a choice at all — the Appearance control is inert if not. */
export function offersBothAppearances(themeId: string): boolean {
  return findDocTheme(themeId).appearances.length > 1
}

export function applyDocTheme(id: string): void {
  const theme = findDocTheme(id)
  docTheme.value = theme.id
  document.documentElement.setAttribute('data-doc-theme', theme.id)
  safeSetItem(DOC_THEME_KEY, theme.id)
}
