import { expect, test, webkit } from '@playwright/test'

async function login(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
}

test('settings captures Tab in both directions and returns focus after Escape', async ({ page }) => {
  await login(page)
  const trigger = page.getByRole('button', { name: 'Settings', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  const close = dialog.getByRole('button', { name: 'Close settings' })
  await expect(close).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Log out' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('a row menu near the bottom opens inside the viewport and restores its trigger', async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 520 })
  await login(page)
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  const row = page.locator('.ink-tree-row').last()
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  const trigger = row.getByRole('button', { name: /^Actions for / })
  await trigger.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Delete', exact: true })).toBeVisible()
  const bounds = (await menu.boundingBox())!
  expect(bounds.y).toBeGreaterThanOrEqual(8)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(513)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('WebKit cannot Tab out through intermediate dialog controls', async () => {
  const browser = await webkit.launch()
  try {
    const page = await browser.newPage({ baseURL: 'http://127.0.0.1:7699' })
    await login(page)
    const trigger = page.getByRole('button', { name: 'Settings', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 0; i < 18; i++) {
        await page.keyboard.press(key)
        expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
      }
    }
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  } finally { await browser.close() }
})
