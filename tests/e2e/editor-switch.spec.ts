import { expect, test, type Page } from '@playwright/test'

/**
 * The setting that chooses which editor is mounted.
 *
 * Two engines ship together while the newer one is being judged, and the whole value of that is
 * being able to go back — a reader in the middle of a note must never be stuck with whichever one
 * happened to be the default. So this checks the three things that promise makes: the default is
 * the older engine, the switch takes effect, and the choice survives a reload.
 *
 * Asserted through what is mounted rather than through `localStorage`, because what the setting is
 * for is which editor you are typing in.
 */

async function openNote(page: Page) {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^grid\.md$/ }).click()
  // Visible is not the same as loaded: the surface is mounted before the note arrives in it.
  await expect.poll(() => page.evaluate(() =>
    (document.querySelector('.ink-doc')?.textContent ?? '').includes('Before.')), { timeout: 15_000 }).toBe(true)
}

const mounted = (page: Page) => page.evaluate(() =>
  document.querySelector('.ink-crepe') ? 'crepe' : document.querySelector('.vditor-ir') ? 'vditor' : 'none')

async function choose(page: Page, engine: 'Crepe' | 'Vditor') {
  await page.locator('button[title="Settings"]').click()
  await page.getByRole('button', { name: engine, exact: true }).click()
  // Switching reloads: the two engines share no DOM and no undo stack, so they are never swapped
  // under a live document.
  await expect(page.locator('.ink-shell')).toBeVisible({ timeout: 15_000 })
}

test('a fresh browser gets the engine that has been shipping', async ({ page }) => {
  await openNote(page)
  expect(await mounted(page)).toBe('vditor')
})

test('the setting switches the editor, and the choice survives a reload', async ({ page }) => {
  await openNote(page)
  await choose(page, 'Crepe')
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^grid\.md$/ }).click()
  await expect.poll(() => mounted(page), { timeout: 15_000 }).toBe('crepe')

  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^grid\.md$/ }).click()
  await expect.poll(() => mounted(page), { timeout: 15_000 }).toBe('crepe')

  // And back, which is the half that matters: the way out has to work from inside.
  await choose(page, 'Vditor')
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^grid\.md$/ }).click()
  await expect.poll(() => mounted(page), { timeout: 15_000 }).toBe('vditor')
})

test('both engines open the same note with the same text', async ({ page }) => {
  await openNote(page)
  const text = () => page.evaluate(() => document.querySelector('.ink-doc')?.textContent?.replace(/\s+/g, '') ?? '')
  const inVditor = await text()

  await choose(page, 'Crepe')
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^grid\.md$/ }).click()
  await expect.poll(() => mounted(page), { timeout: 15_000 }).toBe('crepe')
  await expect.poll(() => text(), { timeout: 15_000 }).toContain('Before.')

  // Not identical: one engine shows the markdown of a table's delimiter row and the other does not.
  // What must match is the note — every word of it, in order.
  const inCrepe = await text()
  for (const word of ['Before.', 'Left', 'Centre', 'Right', 'After.']) {
    expect(inVditor).toContain(word.replace(/\s+/g, ''))
    expect(inCrepe).toContain(word.replace(/\s+/g, ''))
  }
})
