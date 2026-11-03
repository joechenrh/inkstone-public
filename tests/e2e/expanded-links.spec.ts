import { chromium, webkit, expect, test as base, type Locator, type Page } from '@playwright/test'

const test = base.extend({
  page: async ({}, use, info) => {
    const engine = info.titlePath.includes('webkit') ? webkit : chromium
    const browser = await engine.launch()
    try {
      const context = await browser.newContext({ baseURL: 'http://127.0.0.1:7699', viewport: { width: 1000, height: 850 } })
      await use(await context.newPage())
    } finally { await browser.close() }
  },
})

async function open(page: Page) {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^expanded-links\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('After.')
  await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true')
}

async function pointOnText(locator: Locator) {
  return locator.evaluate((span) => {
    const range = document.createRange()
    range.selectNodeContents(span)
    const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 && r.height > 0)!
    return { x: rect.left + Math.min(8, rect.width / 2), y: rect.top + rect.height / 2 }
  })
}

for (const browserName of ['chromium', 'webkit'] as const) {
  test.describe(browserName, () => {
    test('Command-click opens expanded labels and destinations, including URLs with parentheses', async ({ page }) => {
      await page.context().route('https://example.com/**', (route) => route.fulfill({ body: 'Destination' }))
      await open(page)
      const urls = ['https://example.com/docs', 'https://example.com/same',
        'https://example.com/wiki/Foo_(bar)', `https://example.com/${'part/'.repeat(18)}`]
      for (const url of urls) {
        for (const part of ['label', 'target']) {
          await page.locator(`.ink-doc a[href="${url}"]`).click()
          const source = page.locator(`.ink-link-source-${part}`)
          await expect(source).toBeVisible()
          const point = await pointOnText(source)
          await page.keyboard.down('Meta')
          const [popup] = await Promise.all([
            page.waitForEvent('popup'),
            page.mouse.click(point.x, point.y),
          ])
          await page.keyboard.up('Meta')
          await popup.waitForLoadState()
          expect(popup.url()).toBe(url)
          await popup.close()
          await page.bringToFront()
          // Closing the raw syntax again must restore exactly the same destination.
          await page.locator('.ink-doc p').filter({ hasText: /^After\.$/ }).click()
          await expect(page.locator(`.ink-doc a[href="${url}"]`)).toBeVisible()
        }
      }
    })

    test('expanded syntax keeps link styling and leaves blank space inert', async ({ page }) => {
      await open(page)
      const link = page.locator('.ink-doc a[href="https://example.com/docs"]')
      const colour = await link.evaluate((a) => getComputedStyle(a).color)
      await link.click()
      const label = page.locator('.ink-link-source-label')
      const target = page.locator('.ink-link-source-target')
      await expect(label).toHaveCSS('color', colour)
      await expect(label).toHaveCSS('text-decoration-line', 'underline')
      await expect(target).toHaveText('https://example.com/docs')
      const markerColour = await page.locator('.ink-link-source-marker').first().evaluate((s) => getComputedStyle(s).color)
      expect(markerColour).not.toBe(colour)
      await page.screenshot({ path: test.info().outputPath('expanded-link.png'), caret: 'initial' })
      await page.evaluate(() => { window.open = () => { document.documentElement.dataset.opened = 'yes'; return null } })
      const box = (await target.boundingBox())!
      await page.keyboard.down('Meta')
      await page.mouse.click(box.x + box.width + 100, box.y + box.height / 2)
      await page.keyboard.up('Meta')
      expect(await page.locator('html').getAttribute('data-opened')).toBeNull()
    })
  })
}
