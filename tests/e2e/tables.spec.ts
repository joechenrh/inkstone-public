import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Table editing.
 *
 * Vditor implements the operations but binds them to keys a browser keeps for itself — ⌘= and ⌘-
 * are zoom, ⇧⌘C is devtools — and two of its bindings never match at all, so before this there was
 * nothing a person could find and almost nothing they could press. The controls are ours; the edits
 * are made against the rendered table and carried into the document by dispatching `input`.
 *
 * The thing to know when reading these: **Vditor replaces the table element when it re-serialises**,
 * synchronously, so any reference taken before an edit is detached afterwards. Every assertion here
 * re-queries.
 */

async function openGrid(page: Page) {
  await useVditor(page)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^grid\.md$/ }).click()
  await expect(page.locator('.vditor-ir .vditor-reset table')).toBeVisible({ timeout: 15_000 })
}

const size = (page: Page) => page.evaluate(() => {
  const t = document.querySelector<HTMLTableElement>('.vditor-ir .vditor-reset table')
  return t ? `${t.rows.length}x${t.rows[0]!.cells.length}` : 'gone'
})

const caretCell = (page: Page) => page.evaluate(() => {
  const n = document.getSelection()?.anchorNode
  const el = n instanceof Element ? n : n?.parentElement
  const cell = el?.closest('td, th')
  if (!cell) return 'outside'
  const row = cell.parentElement as HTMLTableRowElement
  return `${cell.tagName} r${row.rowIndex} c${(cell as HTMLTableCellElement).cellIndex}`
})

/**
 * Which editor these tests are about.
 *
 * Both engines are mounted while the move to Crepe is judged (`docs/design/editor-engine.md`), and
 * these specs reach into Vditor's own DOM — `.vditor-ir`, `pre.vditor-reset`, its markers. So they
 * say so, rather than testing whichever engine happened to be the default that week. A Crepe suite
 * grows beside them; when one engine goes, so does the line below and the other suite.
 */
async function useVditor(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('inkstone.editorEngine', 'vditor')
  })
}

test('the bar appears only inside a table, above it, and follows the column', async ({ page }) => {
  await openGrid(page)
  await expect(page.locator('.ink-table-bar')).toHaveCount(0)

  await page.locator('.vditor-ir .vditor-reset td').first().click()
  await expect(page.locator('.ink-table-bar')).toBeVisible()

  // In the reserved band, not over the table: a control appearing must never move the document.
  const geom = await page.evaluate(() => {
    const bar = document.querySelector('.ink-table-bar')!.getBoundingClientRect()
    const table = document.querySelector('.vditor-ir .vditor-reset table')!.getBoundingClientRect()
    return { clearsTable: bar.bottom <= table.top, sameLeft: Math.abs(bar.left - table.left) < 2 }
  })
  expect(geom.clearsTable).toBe(true)
  expect(geom.sameLeft).toBe(true)

  // Column 0 is `:---`, column 1 is `:---:` — the buttons report, not just set.
  await expect(page.getByRole('button', { name: 'Align column left' })).toHaveAttribute('aria-pressed', 'true')
  await page.locator('.vditor-ir .vditor-reset td').nth(1).click()
  await expect(page.getByRole('button', { name: 'Align column centre' })).toHaveAttribute('aria-pressed', 'true')

  await page.getByText('After.').click()
  await expect(page.locator('.ink-table-bar')).toHaveCount(0)
})

test('alignment applies to the whole column and reaches the document', async ({ page }) => {
  await openGrid(page)
  await page.locator('.vditor-ir .vditor-reset td').first().click()
  await page.getByRole('button', { name: 'Align column right' }).click()

  await expect.poll(() => page.evaluate(() => Array.from(
    document.querySelectorAll('.vditor-ir .vditor-reset table tr'),
    (r) => (r as HTMLTableRowElement).cells[0]!.getAttribute('align'),
  ).join(','))).toBe('right,right,right')

  // Header included — three themes overrode it, which made the buttons look broken.
  const rendered = await page.evaluate(() => getComputedStyle(
    document.querySelector('.vditor-ir .vditor-reset th')!).textAlign.replace('-webkit-', ''))
  expect(rendered).toBe('right')
})

test('Tab walks the cells and grows the table at the end', async ({ page }) => {
  await openGrid(page)
  await page.locator('.vditor-ir .vditor-reset th').first().click()
  expect(await caretCell(page)).toBe('TH r0 c0')

  await page.keyboard.press('Tab')
  expect(await caretCell(page)).toBe('TH r0 c1')
  // Wraps into the next row rather than stopping at the end of one.
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  expect(await caretCell(page)).toBe('TD r1 c0')
  await page.keyboard.press('Shift+Tab')
  expect(await caretCell(page)).toBe('TH r0 c2')

  // Off the end, the table grows and the caret lands in the new row.
  await page.evaluate(() => {
    const t = document.querySelector<HTMLTableElement>('.vditor-ir .vditor-reset table')!
    const last = t.rows[t.rows.length - 1]!.cells[t.rows[0]!.cells.length - 1]!
    const r = document.createRange()
    r.selectNodeContents(last)
    r.collapse(false)
    const s = document.getSelection()!
    s.removeAllRanges()
    s.addRange(r)
  })
  expect(await size(page)).toBe('3x3')
  await page.keyboard.press('Tab')
  await expect.poll(() => size(page)).toBe('4x3')
  expect(await caretCell(page)).toBe('TD r3 c0')
})

test('the size grid resizes from the end', async ({ page }) => {
  await openGrid(page)
  await page.locator('.vditor-ir .vditor-reset td').first().click()
  await page.getByRole('button', { name: 'Table size' }).click()
  await expect(page.locator('.ink-table-size')).toBeVisible()

  await page.getByRole('button', { name: '4 by 2', exact: true }).click()
  await expect.poll(() => size(page)).toBe('4x2')
  await expect(page.locator('.ink-table-size')).toHaveCount(0)
})

test('the context menu inserts and deletes where it was opened', async ({ page }) => {
  await openGrid(page)
  await page.locator('.vditor-ir .vditor-reset td').nth(1).click({ button: 'right' })
  await expect(page.locator('.ink-table-menu')).toBeVisible()

  await page.getByRole('menuitem', { name: 'Insert column right' }).click()
  await expect.poll(() => size(page)).toBe('3x4')

  await page.locator('.vditor-ir .vditor-reset td').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete row' }).click()
  await expect.poll(() => size(page)).toBe('2x4')
})

// Markdown has no table without a header row, and no table with no columns.
test('the menu refuses the edits that would destroy the table', async ({ page }) => {
  await openGrid(page)
  await page.locator('.vditor-ir .vditor-reset th').first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Delete row' })).toBeDisabled()
  await page.keyboard.press('Escape')

  // Down to one column, then Delete column must go too.
  await page.locator('.vditor-ir .vditor-reset td').first().click()
  await page.getByRole('button', { name: 'Table size' }).click()
  await page.getByRole('button', { name: '2 by 1', exact: true }).click()
  await expect.poll(() => size(page)).toBe('2x1')

  await page.locator('.vditor-ir .vditor-reset td').first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Delete column' })).toBeDisabled()
})

test('a table edit is saved as markdown', async ({ page }) => {
  await openGrid(page)
  await page.locator('.vditor-ir .vditor-reset td').first().click()
  await page.getByRole('button', { name: 'Align column right' }).click()
  await page.keyboard.press('ControlOrMeta+s')

  // Reopening is the only honest check that it was written: the delimiter row is where a
  // column's alignment actually lives in markdown.
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^grid\.md$/ }).click()
  await expect(page.locator('.vditor-ir .vditor-reset table')).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => page.evaluate(() =>
    document.querySelector('.vditor-ir .vditor-reset th')!.getAttribute('align'))).toBe('right')
})

test('read-only mode has no table controls at all', async ({ page }) => {
  await openGrid(page)
  await page.locator('.vditor-ir .vditor-reset td').first().click()
  await expect(page.locator('.ink-table-bar')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+e')
  await expect(page.locator('.ink-table-bar')).toHaveCount(0)

  await page.locator('.vditor-ir .vditor-reset td').first().click({ button: 'right' })
  await expect(page.locator('.ink-table-menu')).toHaveCount(0)
  expect(await size(page)).toBe('3x3')
})
