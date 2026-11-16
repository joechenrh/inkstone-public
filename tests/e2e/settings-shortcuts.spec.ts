import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function openSettings(page: Page, width = 1280, height = 800) {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  if (width < 720) {
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  } else {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  }
  return page.getByRole('dialog', { name: 'Settings', exact: true })
}

test('settings tabs support keyboard navigation, focus containment and returning to preferences', async ({ page }) => {
  const dialog = await openSettings(page)
  const preferences = dialog.getByRole('tab', { name: 'Preferences', exact: true })
  const shortcuts = dialog.getByRole('tab', { name: 'Keyboard shortcuts', exact: true })
  await expect(preferences).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(preferences).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(shortcuts).toBeFocused()
  await expect(shortcuts).toHaveAttribute('aria-selected', 'true')
  const panel = dialog.getByRole('tabpanel', { name: 'Keyboard shortcuts', exact: true })
  await expect(panel).toBeVisible()
  await expect(panel.locator('kbd')).toHaveCount(13)
  await expect(panel).toContainText('Switch Edit / Read')
  await expect(panel).toContainText('Toggle Source / Edit')
  await expect(panel).not.toContainText('Vim')
  await page.keyboard.press('Tab')
  await expect(panel).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(shortcuts).toBeFocused()
  await page.keyboard.press('Home')
  await expect(preferences).toBeFocused()
  await expect(dialog.getByLabel('Source keybindings')).toBeVisible()
  await page.keyboard.press('End')
  await expect(shortcuts).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Preferences', exact: true })).toHaveAttribute('aria-selected', 'true')
})

for (const [width, height] of [[1280, 800], [840, 600], [720, 520], [390, 664], [320, 568], [980, 400]] as const) {
  test(`settings and app shortcut reference fit ${width}×${height}`, async ({ page }) => {
    const dialog = await openSettings(page, width, height)
    const close = dialog.getByRole('button', { name: 'Close settings' })
    const bounds = (await dialog.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height)
    if (width === 1280) expect(bounds.width).toBeGreaterThanOrEqual(800)
    const appearance = await dialog.getByRole('region', { name: 'Appearance', exact: true }).boundingBox()
    const editing = await dialog.getByRole('region', { name: 'Editing', exact: true }).boundingBox()
    if (width >= 800) expect(editing!.x).toBeGreaterThan(appearance!.x + 200)
    else expect(editing!.x).toBe(appearance!.x)
    await expect(close).toBeInViewport()
    if (width === 1280 || width === 390) {
      await page.screenshot({ path: `/tmp/inkstone-settings-preferences-${width}.png` })
    }
    await dialog.getByRole('tab', { name: 'Keyboard shortcuts', exact: true }).click()
    const panel = dialog.getByRole('tabpanel', { name: 'Keyboard shortcuts', exact: true })
    await expect(panel).toBeVisible()
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    if (width === 1280) expect(await panel.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    if (width === 1280 || width === 390) {
      await page.screenshot({ path: `/tmp/inkstone-settings-shortcuts-${width}.png` })
    }
    await panel.getByText('Next visited note', { exact: true }).scrollIntoViewIfNeeded()
    await expect(panel.getByText('Next visited note', { exact: true })).toBeInViewport()
    await expect(close).toBeInViewport()
    await expect(dialog.getByRole('button', { name: 'Log out' })).toBeInViewport()
    if (width === 1280) {
      await page.evaluate(() => {
        document.documentElement.dataset.docTheme = 'plain'
        document.documentElement.dataset.theme = 'dark'
      })
      await page.screenshot({ path: '/tmp/inkstone-settings-shortcuts-dark.png' })
    }
    await close.click()
    await expect(dialog).toHaveCount(0)
  })
}

for (const platform of [
  { name: 'mac-modern', legacy: 'Linux x86_64', hint: 'macOS', apple: true },
  { name: 'mac-legacy', legacy: 'MacIntel', hint: null, apple: true },
  { name: 'windows', legacy: 'Win32', hint: null, apple: false },
  { name: 'linux', legacy: 'Linux x86_64', hint: null, apple: false },
] as const) {
  test(`shortcut reference and view hints match ${platform.name}`, async ({ page }) => {
    await page.addInitScript(({ legacy, hint }) => {
      Object.defineProperty(navigator, 'platform', { configurable: true, value: legacy })
      Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: hint ? { platform: hint } : undefined })
    }, platform)
    const dialog = await openSettings(page)
    await dialog.getByRole('tab', { name: 'Keyboard shortcuts', exact: true }).click()
    const panel = dialog.getByRole('tabpanel', { name: 'Keyboard shortcuts', exact: true })
    const row = (label: string) => panel.locator('.ink-shortcuts-row').filter({ has: page.getByText(label, { exact: true }) }).locator('kbd')
    await expect(row('Switch Edit / Read')).toHaveText(platform.apple ? '⌘E' : 'Ctrl + E')
    await expect(row('Toggle Source / Edit')).toHaveText(platform.apple ? '⌘M' : 'Ctrl + M')
    await expect(row('New note')).toHaveText(platform.apple ? '⌥⌘N' : 'Ctrl + Alt + N')
    await expect(row('Save all drafts')).toHaveText(platform.apple ? '⇧⌘S' : 'Ctrl + Shift + S')
    await expect(row('Switch Edit / Read')).toHaveAttribute('aria-label', platform.apple ? 'Command + E' : 'Control + E')
    await expect(panel).not.toContainText('Cmd/Ctrl')
    const keycaps = (await panel.locator('kbd').allTextContents()).join(' ')
    if (platform.apple) expect(keycaps).not.toMatch(/Ctrl|Alt|Shift/)
    else expect(keycaps).not.toMatch(/[⌘⌥⇧]/)
    await page.screenshot({ path: `/tmp/inkstone-shortcuts-${platform.name}.png` })
    await dialog.getByRole('button', { name: 'Close settings' }).click()
    await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
    await page.locator('.ink-tree-name').filter({ hasText: /^tight\.md$/ }).click()
    const source = page.getByRole('button', { name: /^Markdown source \(/ })
    await expect(source).toHaveAttribute('title', platform.apple ? 'Markdown source (⌘M)' : 'Markdown source (Ctrl+M)')
    await page.keyboard.press(`${platform.apple ? 'Meta' : 'Control'}+m`)
    await expect(source).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press(`${platform.apple ? 'Meta' : 'Control'}+e`)
    await expect(page.getByRole('button', { name: /^Read \(/ })).toHaveAttribute('aria-pressed', 'true')
  })
}
