import { expect, test, type Page } from '@playwright/test'

/**
 * A heading is made and unmade in one keystroke.
 *
 * Backspace against the front of one used to demote it a level, so leaving a `###` took three
 * presses and passed through two headings nobody wanted. And there was no way to *make* one but to
 * type the `#`s.
 *
 * The keys are `Cmd/Ctrl+Opt+N` rather than `Cmd/Ctrl+N` because Chrome and Firefox on macOS take
 * `Cmd+1`…`Cmd+9` for tab switching before a page sees them — the same reason Notion and Google
 * Docs spell theirs that way.
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

const blocks = (page: Page) =>
  page.$$eval('.ink-doc > *', (nodes) => nodes.map((n) => n.tagName).join(','))

test('backspace at the start of a heading takes all of its #s', async ({ page }) => {
  await open(page, 'headings-crepe.md', 'Three')
  expect(await blocks(page)).toMatch(/^H3,/)

  await page.locator('.ink-doc h3').first().click()
  await page.keyboard.press('Home')
  await page.waitForTimeout(250)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(400)

  // A paragraph, in one press — not an `##` on the way to being one.
  expect(await blocks(page)).toMatch(/^P,/)
})

test('the level keys set a level, and set it again to leave', async ({ page }) => {
  await open(page, 'headings-crepe.md', 'plain paragraph')
  const paragraph = page.locator('.ink-doc p').filter({ hasText: 'plain paragraph' })
  await paragraph.click()
  await page.waitForTimeout(250)

  await page.keyboard.press('ControlOrMeta+Alt+Digit2')
  await page.waitForTimeout(300)
  await expect(page.locator('.ink-doc h2')).toContainText('plain paragraph')

  // The same key again is how it comes off.
  await page.keyboard.press('ControlOrMeta+Alt+Digit2')
  await page.waitForTimeout(300)
  await expect(page.locator('.ink-doc h2')).toHaveCount(0)

  // A different level replaces it; zero is the plain word for removing it.
  await page.keyboard.press('ControlOrMeta+Alt+Digit4')
  await page.waitForTimeout(300)
  await expect(page.locator('.ink-doc h4')).toContainText('plain paragraph')
  await page.keyboard.press('ControlOrMeta+Alt+Digit0')
  await page.waitForTimeout(300)
  await expect(page.locator('.ink-doc h4')).toHaveCount(0)
})

test('and do nothing where a heading cannot be', async ({ page }) => {
  await open(page, 'headings-crepe.md', 'const x = 1')
  const before = await blocks(page)

  // In a fenced block the keys are CodeMirror's, and this listener runs before it sees them.
  await page.locator('.milkdown-code-block .cm-line').first().click()
  await page.waitForTimeout(300)
  await page.keyboard.press('ControlOrMeta+Alt+Digit1')
  await page.waitForTimeout(300)
  expect(await blocks(page)).toBe(before)

  // In a table cell a heading is not something the schema allows.
  await page.locator('.ink-doc table td').first().click()
  await page.waitForTimeout(300)
  await page.keyboard.press('ControlOrMeta+Alt+Digit1')
  await page.waitForTimeout(300)
  expect(await blocks(page)).toBe(before)
  await expect(page.locator('.ink-doc table h1')).toHaveCount(0)
})
