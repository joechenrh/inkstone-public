/** Browser-reported platform, including iPadOS when it reports itself as a Mac. */
export function usesCommandKey(): boolean {
  if (typeof navigator === 'undefined') return false
  const browser = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = browser.userAgentData?.platform || browser.platform || browser.userAgent
  return /Mac|iPhone|iPad|iPod/i.test(platform)
}

/** Mod is the app's primary modifier; compact labels are suitable for native Mac key symbols. */
export function shortcutLabel(keys: string): string {
  if (!usesCommandKey()) return keys.replace(/\bMod\b/g, 'Ctrl')
  return keys
    .replace(/\bMod\b/g, '⌘').replace(/\bAlt\b/g, '⌥').replace(/\bShift\b/g, '⇧')
    .replace(/\s*\+\s*/g, '').replace(/⌘([⌥⇧])/g, '$1⌘')
}

/** Spoken names accompany the symbols in the shortcut reference. */
export function shortcutDescription(keys: string): string {
  if (!usesCommandKey()) return keys.replace(/\bMod\b/g, 'Control')
  return keys.replace(/\bMod\b/g, 'Command').replace(/\bAlt\b/g, 'Option')
}
