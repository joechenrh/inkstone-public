/**
 * localStorage access that cannot throw.
 *
 * Its own module because both useTheme and docThemes need it, and having docThemes import it from
 * useTheme made the two circular: useTheme's `resolvedTheme` is initialised at module scope and
 * asks docThemes which appearances the theme has, while docThemes was still waiting for useTheme
 * to finish. The page rendered nothing and threw "Cannot access 'yo' before initialization".
 */
export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Safari private mode and storage-denied configs throw here; ignore.
  }
}
