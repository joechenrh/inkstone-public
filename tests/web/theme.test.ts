import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, applyThemeChoice, readStoredTheme, readThemeChoice, resolvedTheme, THEME_STORAGE_KEY } from '../../src/web/theme/useTheme.js'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('applyTheme', () => {
  it('writes the data-theme attribute', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('persists to localStorage', () => {
    applyTheme('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('when switching back to light, still writes the attribute rather than removing it', () => {
    applyTheme('dark')
    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

describe('readStoredTheme', () => {
  it('falls back to light when nothing is stored', () => {
    expect(readStoredTheme()).toBe('light')
  })

  it('reads the stored value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    expect(readStoredTheme()).toBe('dark')
  })

  it('ignores an invalid value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    expect(readStoredTheme()).toBe('light')
  })
})

// ---------------------------------------------------------------------------
// matchMedia coverage (jsdom has no matchMedia; we stub it per test)
// ---------------------------------------------------------------------------

/** Helper: build a minimal matchMedia stub that reports the given dark preference. */
function makeMatchMedia(prefersDark: boolean) {
  return (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

describe('readStoredTheme — matchMedia fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('no stored value + matchMedia reports dark → returns dark', () => {
    vi.stubGlobal('matchMedia', makeMatchMedia(true))
    expect(readStoredTheme()).toBe('dark')
  })

  it('no stored value + matchMedia reports light → returns light', () => {
    vi.stubGlobal('matchMedia', makeMatchMedia(false))
    expect(readStoredTheme()).toBe('light')
  })

  it('stored light wins over matchMedia dark', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    vi.stubGlobal('matchMedia', makeMatchMedia(true))
    expect(readStoredTheme()).toBe('light')
  })

  it('stored dark wins over matchMedia light', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    vi.stubGlobal('matchMedia', makeMatchMedia(false))
    expect(readStoredTheme()).toBe('dark')
  })

  it('matchMedia throwing does not propagate — falls through to light', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('matchMedia not available')
    })
    expect(() => readStoredTheme()).not.toThrow()
    expect(readStoredTheme()).toBe('light')
  })
})

// ---------------------------------------------------------------------------
// localStorage-throws coverage
// ---------------------------------------------------------------------------

describe('localStorage unavailable', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('readStoredTheme returns light when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    expect(() => readStoredTheme()).not.toThrow()
    expect(readStoredTheme()).toBe('light')
  })

  it('applyTheme stamps data-theme even when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    expect(() => applyTheme('dark')).not.toThrow()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})

// ---------------------------------------------------------------------------
// Three-state theme (system | light | dark)
// ---------------------------------------------------------------------------

describe('resolvedTheme signal', () => {
  it('resolvedTheme=dark after applyThemeChoice(dark)', () => {
    applyThemeChoice('dark')
    expect(resolvedTheme.value).toBe('dark')
  })
  it('resolvedTheme=light after applyThemeChoice(light)', () => {
    applyThemeChoice('light')
    expect(resolvedTheme.value).toBe('light')
  })
})

describe('three-state theme', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('readThemeChoice defaults to system', () => {
    localStorage.clear()
    expect(readThemeChoice()).toBe('system')
  })
  it('applyThemeChoice(dark) stores and sets data-theme=dark', () => {
    applyThemeChoice('dark')
    expect(localStorage.getItem('inkstone.theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
  it('applyThemeChoice(system) follows matchMedia', () => {
    const mql = { matches: true, addEventListener() {}, removeEventListener() {} }
    vi.stubGlobal('matchMedia', () => mql)
    applyThemeChoice('system')
    expect(localStorage.getItem('inkstone.theme')).toBe('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark') // matches:true → dark
    vi.unstubAllGlobals()
  })
})
