import { expect, test, type Page } from '@playwright/test'

/**
 * A note, on paper.
 *
 * Printing had never been arranged: `Cmd+P` produced the application — sidebar, top bar, status
 * bar and a scrolled slice of the note. The whole feature is a stylesheet plus one event, and it
 * adds nothing to the screen: the browser's own print dialogue is also its "export to PDF".
 */
async function open(page: Page, note: string, expectText: string) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText(expectText, { timeout: 15_000 })
}

test('the application is not printed, only the note is', async ({ page }) => {
  await open(page, 'rich.md', 'Heading level 1')
  await page.emulateMedia({ media: 'print' })

  for (const chrome of ['.ink-left', '.ink-topbar', '.ink-statusbar']) {
    await expect(page.locator(chrome)).toBeHidden()
  }
  // The editor's own furniture is not part of the note either.
  expect(await page.evaluate(() =>
    getComputedStyle(document.querySelector('.milkdown-code-block > .tools')!).display)).toBe('none')

  // And the document is laid out for paper rather than for a scroller.
  expect(await page.evaluate(() => {
    const el = document.querySelector('.ink-doc')!
    const cs = getComputedStyle(el)
    return { overflow: cs.overflow, maxWidth: cs.maxWidth }
  })).toEqual({ overflow: 'visible', maxWidth: 'none' })
})

/**
 * A dark theme on paper is a rectangle of toner, and its light text on white is an empty sheet.
 * The stylesheet cannot fix that — measured: an `!important` rule at higher specificity than the
 * theme's, injected with no media query at all, did not move the document's background — so the
 * appearance is switched for the duration of the print instead.
 */
test('printing happens in the light appearance, and the dark one comes back', async ({ page }) => {
  await open(page, 'rich.md', 'Heading level 1')
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark') })
  await page.waitForTimeout(200)

  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')

  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark')
})
