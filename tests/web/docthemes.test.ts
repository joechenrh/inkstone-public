import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyDocTheme,
  clampAppearance,
  DEFAULT_DOC_THEME,
  DOC_THEME_KEY,
  DOC_THEMES,
  docTheme,
  findDocTheme,
  offersBothAppearances,
  readDocTheme,
} from '../../src/web/theme/docThemes.js'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-doc-theme')
  docTheme.value = DEFAULT_DOC_THEME
})

describe('document themes', () => {
  it('every theme declares at least one appearance', () => {
    for (const t of DOC_THEMES) {
      expect(t.appearances.length, t.id).toBeGreaterThan(0)
      expect(t.name, t.id).toBeTruthy()
    }
  })

  it('applying a theme stamps it, stores it, and updates the signal', () => {
    applyDocTheme('plain')
    expect(document.documentElement.getAttribute('data-doc-theme')).toBe('plain')
    expect(localStorage.getItem(DOC_THEME_KEY)).toBe('plain')
    expect(docTheme.value).toBe('plain')
    expect(readDocTheme()).toBe('plain')
  })

  it('falls back to the default for a theme that no longer exists', () => {
    localStorage.setItem(DOC_THEME_KEY, 'a-theme-that-was-removed')
    expect(readDocTheme()).toBe(DEFAULT_DOC_THEME)
  })

  // A theme that ships one look cannot show the other. Since the chrome takes its colour from the
  // theme, forcing it would leave a dark shell around a white page — the exact seam the
  // chrome-follows-the-theme decision exists to prevent.
  describe('appearance is clamped to what the theme has', () => {
    it('passes through when the theme has both', () => {
      expect(clampAppearance('lapis', 'dark')).toBe('dark')
      expect(clampAppearance('lapis', 'light')).toBe('light')
      expect(offersBothAppearances('lapis')).toBe(true)
    })

    it('a single-appearance theme wins over the request', () => {
      const single = { id: 'x', name: 'X', appearances: ['dark' as const], note: '' }
      DOC_THEMES.push(single)
      try {
        expect(clampAppearance('x', 'light')).toBe('dark')
        expect(offersBothAppearances('x')).toBe(false)
      } finally {
        DOC_THEMES.pop()
      }
    })

    it('an unknown theme resolves to the default rather than throwing', () => {
      expect(findDocTheme('nope').id).toBe(DEFAULT_DOC_THEME)
      expect(clampAppearance('nope', 'dark')).toBe('dark')
    })
  })
})
