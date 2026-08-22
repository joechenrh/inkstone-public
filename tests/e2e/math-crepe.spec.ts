import { expect, test, type Page } from '@playwright/test'

/**
 * Maths: `$x$` in a line, `$$…$$` as a block.
 *
 * The feature was declined once, on the grounds that these notes are about linkers and assembly and
 * `push $0x1` is not maths. That is still true inside a fence, where the assembly is, and it is the
 * reason the fixture has one: what a formula must not do is claim anything that is not a formula.
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

const noteText = (page: Page, path: string) => page.evaluate(async (p) => {
  const res = await fetch(`/api/file?path=${encodeURIComponent(p)}`)
  return (await res.json() as { content: string }).content
}, path)

test('a formula renders in the line and as a block', async ({ page }) => {
  await openNote(page, 'math-crepe.md', 'Inline')

  // In the line, in the middle of a sentence.
  await expect(page.locator('.ink-doc p .katex').first()).toBeVisible()

  // And as a block, which shows its formula rather than its source: Crepe opens both at once by
  // default, which is twice the height and neither one the document.
  const formula = page.locator('.ink-doc .milkdown-code-block').first()
  await expect(formula.locator('.katex')).not.toHaveCount(0)
  await expect(formula.locator('.cm-editor')).toBeHidden()

  // The fence is not maths and is untouched by any of it.
  await expect(page.locator('.ink-doc .milkdown-code-block').last()).toContainText('const x = 1')
})

test('opening a note with maths in it and saving changes nothing', async ({ page }) => {
  await openNote(page, 'math-crepe.md', 'Inline')
  const before = await noteText(page, 'notes/math-crepe.md')

  await page.locator('.ink-doc p').first().click()
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)

  expect((await noteText(page, 'notes/math-crepe.md')).trimEnd()).toBe(before.trimEnd())
})

test('a dollar sign in a fence is not a formula', async ({ page }) => {
  await openNote(page, 'math-crepe.md', 'Inline')
  await expect(page.locator('.ink-doc .milkdown-code-block').last().locator('.katex')).toHaveCount(0)
})
