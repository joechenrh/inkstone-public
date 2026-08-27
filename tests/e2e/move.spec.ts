import { expect, test, type Page } from '@playwright/test'

/**
 * Moving a note between folders.
 *
 * The server has always taken `rename(from, to)` as two full paths and made the destination's
 * parent; only the sidebar was narrower than that, offering a field that held a name. "Move…" opens
 * the same field on the whole path, and a slash typed into a plain rename does the same thing.
 */
async function login(page: Page) {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await expect(page.locator('[role="tree"]')).toBeVisible()
}

const tree = (page: Page) => page.locator('[role="tree"]')

async function makeNote(page: Page, name: string) {
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New file' }).click()
  const input = page.locator('.ink-tree-inline-input')
  await input.fill(name)
  await input.press('Enter')
  await expect(tree(page).getByText(name)).toBeVisible()
}

async function openMenu(page: Page, name: string, item: string) {
  await tree(page).getByText(name).hover()
  await page.getByRole('button', { name: `Actions for ${name}` }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

test('move: a note goes into a folder, and the folder opens to show it', async ({ page }) => {
  await login(page)
  await makeNote(page, 'e2e-move.md')

  await openMenu(page, 'e2e-move.md', 'Move')
  const input = page.locator('.ink-tree-inline-input')
  // The field holds the whole path — that is what makes the move visible rather than a trick.
  await expect(input).toHaveValue('e2e-move.md')
  await input.fill('notes/e2e-move.md')
  await input.press('Enter')

  // It is gone from the root, present under `notes`, and `notes` was expanded to show it.
  await expect(tree(page).getByText('e2e-move.md')).toBeVisible()
  // Depth is drawn as the row's indent, so a moved note sits one level in rather than at the root.
  const indentOf = (name: string) => tree(page).getByText(name).evaluate((el) => {
    const row = el.closest('[role="treeitem"]')
    return row ? parseFloat(getComputedStyle(row as HTMLElement).paddingLeft) : null
  })
  const rootIndent = await indentOf('notes')
  await expect.poll(() => indentOf('e2e-move.md')).toBeGreaterThan(rootIndent!)

  // And it survives a reload, which reads the tree from disk rather than from the signal.
  await page.reload()
  await expect(tree(page)).toBeVisible()
  if (await tree(page).getByText('e2e-move.md').count() === 0) {
    await tree(page).getByText('notes').click()
  }
  await expect(tree(page).getByText('e2e-move.md')).toBeVisible()

  await openMenu(page, 'e2e-move.md', 'Delete')
  await page.getByTitle('Confirm delete').click()
  await expect(tree(page).getByText('e2e-move.md')).toHaveCount(0)
})

test('move: a slash in the rename field moves too, and the note stays open', async ({ page }) => {
  await login(page)
  await makeNote(page, 'e2e-slash.md')
  await tree(page).getByText('e2e-slash.md').click()

  await openMenu(page, 'e2e-slash.md', 'Rename')
  const input = page.locator('.ink-tree-inline-input')
  await input.fill('notes/e2e-slashed.md')
  await input.press('Enter')

  await expect(tree(page).getByText('e2e-slashed.md')).toBeVisible()
  // The open document followed the file rather than pointing at a path that no longer exists.
  await expect(page.locator('.ink-breadcrumb')).toContainText('e2e-slashed.md')

  await openMenu(page, 'e2e-slashed.md', 'Delete')
  await page.getByTitle('Confirm delete').click()
})
