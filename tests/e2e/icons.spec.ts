import { expect, test } from '@playwright/test'

/**
 * The drawing standard, measured off the page.
 *
 * A set of twenty-eight icons is twenty-eight chances to make a different decision, and the
 * differences are exactly what reads as "assembled" rather than drawn. Before this the gear was
 * 22×22 against the brackets' 14×9 in the same button row — half again as large, with four times
 * the ink — and three rounded rects carried three different corner radii.
 *
 * `getBBox` answers in the icon's own 24-unit grid, so the numbers here are the ones a designer
 * would use: the drawn extent, and where its middle is.
 */
const LIMIT = 18.5
const OFF_CENTRE = 0.4

test('every icon on screen is drawn to the same optical size', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toBeVisible({ timeout: 15_000 })

  const measure = () => page.evaluate(() => Array.from(document.querySelectorAll('svg.ink-icon'))
    .map((el) => {
      const box = (el as SVGGraphicsElement).getBBox()
      // The class it carries is the only name it has on screen; the shape is the fallback.
      const name = (el.getAttribute('class') ?? '').replace('ink-icon', '').trim()
        || Array.from(el.children).map((c) => c.tagName).join('+')
      return {
        name,
        w: +box.width.toFixed(1),
        h: +box.height.toFixed(1),
        cx: +(box.x + box.width / 2).toFixed(1),
        cy: +(box.y + box.height / 2).toFixed(1),
        stroke: getComputedStyle(el).strokeWidth,
      }
    })
    .filter((i) => i.w > 0))

  const seen = new Map<string, Awaited<ReturnType<typeof measure>>[number]>()
  for (const icon of await measure()) seen.set(icon.name, icon)

  // The row menu, which is where the rest of the set lives.
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).hover()
  await page.getByRole('button', { name: 'Actions for rich.md' }).click()
  await page.waitForTimeout(200)
  for (const icon of await measure()) seen.set(icon.name, icon)

  const icons = [...seen.values()]
  expect(icons.length, 'no icons were measured at all').toBeGreaterThan(8)

  const tooBig = icons.filter((i) => i.w > LIMIT || i.h > LIMIT)
  expect(tooBig, `bigger than the ${LIMIT}-unit box: ` +
    tooBig.map((i) => `${i.name} ${i.w}×${i.h}`).join(', ')).toEqual([])

  const off = icons.filter((i) => Math.abs(i.cx - 12) > OFF_CENTRE || Math.abs(i.cy - 12) > OFF_CENTRE)
  expect(off, 'off the centre of the box: ' +
    off.map((i) => `${i.name} at ${i.cx},${i.cy}`).join(', ')).toEqual([])

  // One stroke weight, or the set has two thicknesses in one row.
  const weights = [...new Set(icons.map((i) => i.stroke))]
  expect(weights, `more than one stroke weight: ${weights.join(', ')}`).toHaveLength(1)
})
