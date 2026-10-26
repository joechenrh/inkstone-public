import { expect, test, type Page } from '@playwright/test'

/**
 * A long line in a fence wraps instead of running off the side.
 *
 * CodeMirror scrolls horizontally by default, which is right in an editor and wrong in a note: a
 * fence here is read beside the prose around it, and the scroll is *per block*, so a note with
 * three long fences in it has three separate places to drag. Reported as 不方便看.
 *
 * Measured off the page rather than asserted from the extension list — `EditorView.lineWrapping`
 * being in an array proves nothing about what the reader sees, and a stylesheet elsewhere could
 * undo it.
 */

async function open(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^wrap-crepe\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('Before.', { timeout: 15_000 })
  await expect(page.locator('.milkdown-code-block')).toBeVisible({ timeout: 15_000 })
}

test('a line wider than the block wraps rather than scrolling', async ({ page }) => {
  await open(page)

  const measured = await page.evaluate(() => {
    const scroller = document.querySelector('.milkdown-code-block .cm-scroller')
    const lines = Array.from(document.querySelectorAll('.milkdown-code-block .cm-line'))
    const long = lines.find((el) => (el.textContent ?? '').includes('compute_everything'))
    const short = lines.find((el) => (el.textContent ?? '').trim() === 'short = 1')
    if (scroller === null || long === undefined || short === undefined) return null
    return {
      // Nothing to scroll sideways to: the content fits the block's width.
      overflow: scroller.scrollWidth - scroller.clientWidth,
      long: long.getBoundingClientRect().height,
      short: short.getBoundingClientRect().height,
    }
  })

  expect(measured, 'the fence did not render').not.toBeNull()
  // A pixel of slack: sub-pixel layout, not a scrollbar.
  expect(measured!.overflow, 'the block still scrolls sideways').toBeLessThanOrEqual(1)
  // And it wrapped rather than being clipped: the long line is taller than a single line.
  expect(measured!.long).toBeGreaterThan(measured!.short * 1.5)
})
