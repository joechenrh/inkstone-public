import { expect, test, type Page } from '@playwright/test'

/**
 * A fenced block is a note about code, not an IDE.
 *
 * Crepe builds its CodeMirror from `basicSetup`, which brings `autocompletion()` with it, so typing
 * in a fence marked `js` opened a suggestion list over the note. Reported as exactly that.
 */

async function openNote(page: Page, note: string, expectText: string) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText(expectText, { timeout: 15_000 })
}

test('typing in a fence offers no completions', async ({ page }) => {
  await openNote(page, 'fence-crepe.md', 'const x = 1')

  await page.locator('.milkdown-code-block .cm-line').first().click()
  await page.keyboard.press('End')
  // `con` is the prefix that used to offer `const`, `continue` and `functiondefinition`.
  await page.keyboard.type('\ncon', { delay: 60 })
  await page.waitForTimeout(600)
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0)

  // Not by hiding the box: there is nothing to ask for either, so the shortcut cannot open a list
  // whose keys would then be swallowed by something invisible.
  await page.keyboard.press('Control+Space')
  await page.waitForTimeout(400)
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0)

  // And what was typed is in the block.
  await expect(page.locator('.milkdown-code-block .cm-content')).toContainText('con')
})
