import { expect, test, type Page } from '@playwright/test'

/**
 * The mark on a deliberate commit is one mark per commit.
 *
 * It is a 2px rail down the left of the entry, and it used to be inset by 1px — so three commits in
 * a row drew three rails 2px apart, which at that width reads as a single bar with hairlines across
 * it. Round ends nobody can see are not round ends. The gap has to be wider than the rail before a
 * reader takes them as separate marks.
 */
async function commitOnce(page: Page, text: string, message: string) {
  await page.locator('.ink-doc').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(600)
  await page.locator('[title="Commit"]').click()
  await page.locator('.ink-commit-message').fill(message)
  await page.keyboard.press('Enter')
  await expect(page.locator('.ink-commit')).toHaveCount(0, { timeout: 15_000 })
}

test('consecutive commits are marked once each, not with one long bar', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^welcome\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toBeVisible({ timeout: 15_000 })

  await commitOnce(page, ' one', 'rail one')
  await commitOnce(page, ' two', 'rail two')

  await page.keyboard.press('ControlOrMeta+/')
  await expect(page.locator('.ink-right')).toContainText('rail two', { timeout: 15_000 })
  await page.waitForTimeout(400)

  const rails = await page.evaluate(() => Array.from(document.querySelectorAll('.ink-hist-item.anchor'))
    .map((el) => {
      const s = getComputedStyle(el, '::before')
      const box = el.getBoundingClientRect()
      return {
        width: parseFloat(s.width),
        radius: parseFloat(s.borderTopLeftRadius),
        top: box.top + parseFloat(s.top),
        bottom: box.bottom - parseFloat(s.bottom),
      }
    })
    .sort((a, b) => a.top - b.top))

  expect(rails.length).toBeGreaterThanOrEqual(2)
  // Round ends, which a border cannot have.
  expect(rails[0]!.radius).toBeGreaterThanOrEqual(rails[0]!.width / 2)
  // And a gap between neighbours that is wider than the rail itself, or they read as one bar.
  const gaps = rails.slice(1).map((r, i) => r.top - rails[i]!.bottom)
  expect(Math.min(...gaps), `rails ${gaps.join(', ')}px apart at ${rails[0]!.width}px wide`)
    .toBeGreaterThan(rails[0]!.width * 2)
})
