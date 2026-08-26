import { expect, test, type Page } from '@playwright/test'

/**
 * The table bar, driving the other engine.
 *
 * It is the same component and the same fixture as `tables.spec.ts`; what differs is everything
 * underneath. There the bar hands the editor a function that mutates the live `<table>`, because
 * that engine's document *is* the DOM. Here it says what it wants and the editor answers with a
 * transaction. These tests exist to hold that seam: the bar's behaviour must not depend on which
 * side of it is listening.
 *
 * Assertions go through the rendered table and the saved markdown rather than through either
 * engine's internals, so nothing here would have to change if a third engine turned up.
 */

async function useCrepe(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('inkstone.editorEngine', 'crepe')
  })
}

async function openGrid(page: Page) {
  await useCrepe(page)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^grid-crepe\.md$/ }).click()
  // Not `.first()`: the hidden drag-preview table is first in the DOM and never visible.
  await expect.poll(() => size(page), { timeout: 15_000 }).toBe('3x3')
}

/** The table on the page. This engine keeps a hidden one as a drag preview; that is not it. */
const size = (page: Page) => page.evaluate(() => {
  const t = Array.from(document.querySelectorAll('.ink-doc table'))
    .find((e) => e.getBoundingClientRect().width > 0) as HTMLTableElement | undefined
  return t ? `${t.rows.length}x${t.rows[0]!.cells.length}` : 'gone'
})

const columnAlignments = (page: Page) => page.evaluate(() => {
  const t = Array.from(document.querySelectorAll('.ink-doc table'))
    .find((e) => e.getBoundingClientRect().width > 0) as HTMLTableElement | undefined
  return Array.from(t?.rows[0]?.cells ?? []).map((c) => getComputedStyle(c).textAlign)
})

async function caretIntoFirstBodyCell(page: Page) {
  const cell = page.locator('.ink-doc td').first()
  await cell.scrollIntoViewIfNeeded()
  await cell.click()
  await expect(page.locator('.ink-table-bar')).toHaveCount(1)
}

test('the bar is there only while the caret is in a table', async ({ page }) => {
  await openGrid(page)
  await expect(page.locator('.ink-table-bar')).toHaveCount(0)

  await caretIntoFirstBodyCell(page)

  // A paragraph *outside* the table: this engine wraps every cell's content in a `p` too, so the
  // first one on the page is inside the table and clicking it would leave the bar up, correctly.
  await page.locator('.ink-doc > p').first().click()
  await expect(page.locator('.ink-table-bar')).toHaveCount(0)
})

test('alignment applies to the whole column and reaches the file', async ({ page }) => {
  await openGrid(page)
  await caretIntoFirstBodyCell(page)

  await page.locator('.ink-table-bar button[aria-label="Align column right"]').click()
  // The column the caret is in, and only that one — the others keep whatever the file said.
  await expect.poll(async () => (await columnAlignments(page))[0]).toBe('right')

  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => {
    const res = await page.request.get('/api/file?path=notes/grid-crepe.md')
    return (await res.json() as { content: string }).content
  }).toContain('| ---:')
})

test('the size grid resizes from the end and keeps what was there', async ({ page }) => {
  await openGrid(page)
  await caretIntoFirstBodyCell(page)
  expect(await size(page)).toBe('3x3')

  await page.locator('.ink-table-bar button[aria-label="Table size"]').click()
  await page.locator('.ink-table-cell[aria-label="4 by 2"]').click()
  await expect.poll(() => size(page)).toBe('4x2')

  // The header the fixture came with is still the header: growing and shrinking is not retyping.
  await expect(page.locator('.ink-doc th').first()).toHaveText(/\S/)
})

test('delete takes the table and leaves the rest of the note', async ({ page }) => {
  await openGrid(page)
  await caretIntoFirstBodyCell(page)

  await page.locator('.ink-table-bar button[aria-label="Delete table"]').click()
  await expect.poll(() => size(page)).toBe('gone')
  await expect(page.locator('.ink-doc p').first()).toBeVisible()
})

test('read-only has no bar at all', async ({ page }) => {
  await openGrid(page)
  await page.locator('button[title^="Read"]').first().click()
  const cell = page.locator('.ink-doc td').first()
  await cell.scrollIntoViewIfNeeded()
  await cell.click()
  await expect(page.locator('.ink-table-bar')).toHaveCount(0)
})

/**
 * Walls: blocks that fill their own line and leave nowhere to stand beside them.
 *
 * A code block and a table are both one, and every combination of two of them had the same defect —
 * no way to put a line between. Reported twice as two bugs, which is what one bug looks like when
 * it is fixed a pair at a time. The tests are written as the pairs for the same reason: if the rule
 * is ever narrowed back to one of them, three of these fail.
 */
async function openNote(page: Page, note: string, contains: string) {
  await useCrepe(page)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText(contains, { timeout: 15_000 })
}

/** Only the tables that are on screen: this engine keeps a hidden one as a drag preview. */
const visibleTables = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('.ink-doc table')).filter((t) => t.getBoundingClientRect().width > 0).length)

/** Put the caret at the very start of the first cell of the nth visible table. */
async function caretInFirstCell(page: Page, index: number) {
  await page.evaluate((n) => {
    const table = Array.from(document.querySelectorAll('.ink-doc table'))
      .filter((t) => t.getBoundingClientRect().width > 0)[n]!
    const cell = table.querySelector('th, td')!
    const range = document.createRange()
    range.selectNodeContents(cell)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }, index)
  await page.waitForTimeout(200)
}

/** Put the caret on the first line of the nth code block, inside its CodeMirror. */
async function caretInFence(page: Page, index: number) {
  await page.evaluate((n) => {
    const block = document.querySelectorAll('.milkdown-code-block')[n]!
    const line = block.querySelector('.cm-line')!
    const range = document.createRange()
    range.selectNodeContents(line)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(block.querySelector('.cm-content') as HTMLElement | null)?.focus()
  }, index)
  await page.waitForTimeout(200)
}

const noteText = (page: Page, path: string) => page.evaluate(async (p) => {
  const res = await fetch(`/api/file?path=${encodeURIComponent(p)}`)
  return (await res.json() as { content: string }).content
}, path)

for (const wall of [
  { name: 'table above a table', at: (page: Page) => caretInFirstCell(page, 1), typed: 'between-tables' },
  { name: 'table above a fence', at: (page: Page) => caretInFence(page, 0), typed: 'between-table-fence' },
  { name: 'fence above a table', at: (page: Page) => caretInFirstCell(page, 2), typed: 'between-fence-table' },
]) {
  test(`up opens a line: ${wall.name}`, async ({ page }) => {
    await openNote(page, 'walls-crepe.md', 'After.')
    await wall.at(page)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.type(wall.typed)
    await page.waitForTimeout(400)
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(700)
    expect(await noteText(page, 'notes/walls-crepe.md')).toContain(`\n\n${wall.typed}\n\n`)
  })
}

test('up opens a line above a wall that starts the note', async ({ page }) => {
  // The same rule with one side missing: nothing at all is as unreachable as another wall.
  await openNote(page, 'topwall-crepe.md', 'After.')
  await caretInFence(page, 0)
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('above')
  await page.waitForTimeout(400)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  expect(await noteText(page, 'notes/topwall-crepe.md')).toMatch(/^above\n/)
})

test('backspace in an empty table removes it, and only an empty one', async ({ page }) => {
  await openNote(page, 'walls-crepe.md', 'After.')
  const before = await visibleTables(page)

  // The first table has text in it. Backspace at the start of its first cell is not a delete.
  await caretInFirstCell(page, 0)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  expect(await visibleTables(page)).toBe(before)

  // The empty one goes — the only way to remove a table without knowing where its menu is.
  await caretInFirstCell(page, before - 1)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  expect(await visibleTables(page)).toBe(before - 1)
})

test('and from any cell of it, because they all look the same', async ({ page }) => {
  // Reported as "this table cannot be deleted" by someone whose caret was in the first *body*
  // cell: an empty table is a grid of identical empty boxes and the top-left one is not a place
  // the reader can pick out. Nothing in any of them is a thing Backspace could otherwise be for.
  await openNote(page, 'emptytable-crepe.md', 'After.')
  expect(await visibleTables(page)).toBe(1)

  await page.evaluate(() => {
    const cells = document.querySelectorAll('.ink-doc table td, .ink-doc table th')
    const range = document.createRange()
    range.selectNodeContents(cells[cells.length - 1]!)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.waitForTimeout(250)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(400)
  expect(await visibleTables(page)).toBe(0)
})

/**
 * The other half of opening a line beside a wall: taking it back.
 *
 * ProseMirror answers Backspace in an empty paragraph after a table by *selecting the table* — it
 * cannot join one into the other — so the line stayed, the caret jumped into the grid, and the next
 * Backspace, pressed because the first appeared to do nothing, took the whole table. Measured in
 * that order.
 */
test('backspace takes back a line opened beside a wall', async ({ page }) => {
  await openNote(page, 'walls2-crepe.md', 'After.')
  const tables = await visibleTables(page)
  const blocks = () => page.$$eval('.ink-doc > *', (nodes) => nodes.length)
  const before = await blocks()

  // Between the first two tables, where there was nowhere to stand.
  await caretInFirstCell(page, 1)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(300)
  expect(await blocks()).toBe(before + 1)

  await page.keyboard.press('Backspace')
  await page.waitForTimeout(400)
  expect(await blocks()).toBe(before)
  // And the table it was beside is still there.
  expect(await visibleTables(page)).toBe(tables)
})

test('a click into an empty cell still counts as being in it', async ({ page }) => {
  // Clicking an empty cell selects it rather than putting a caret in it — there is no text to put
  // one in — and the first version tested `selection.empty` and so refused the case it was for.
  await openNote(page, 'walls-crepe.md', 'After.')
  const before = await visibleTables(page)
  const box = await page.evaluate((n) => {
    const table = Array.from(document.querySelectorAll('.ink-doc table'))
      .filter((t) => t.getBoundingClientRect().width > 0)[n]!
    const rect = table.querySelector('th, td')!.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }, before - 1)

  await page.mouse.click(box.x, box.y)
  await page.waitForTimeout(300)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  expect(await visibleTables(page)).toBe(before - 1)
})

/**
 * A quote at the top of a note.
 *
 * Not a wall — the caret goes into its lines like any other paragraph — but the *first* line of one
 * that opens a note has nothing above it, and an alert is a quote, so a note that begins with one
 * could not be given a line above it at all.
 */

/** Put the caret in the nth paragraph of the first quote. */
async function caretInQuote(page: Page, index: number) {
  await page.evaluate((n) => {
    const line = document.querySelectorAll('.ink-doc blockquote p')[n]!
    const range = document.createRange()
    range.selectNodeContents(line)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }, index)
  await page.waitForTimeout(200)
}

const blockNames = (page: Page) =>
  page.$$eval('.ink-doc > *', (nodes) => nodes.map((n) => n.tagName))

test('up opens a line above a quote that starts the note', async ({ page }) => {
  await openNote(page, 'topquote-crepe.md', 'After.')
  expect(await blockNames(page)).toEqual(['BLOCKQUOTE', 'P'])

  await caretInQuote(page, 0)
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('above')
  await page.waitForTimeout(400)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  expect(await noteText(page, 'notes/topquote-crepe.md')).toMatch(/^above\n/)
})

test('up inside a quote still moves inside it', async ({ page }) => {
  await openNote(page, 'topquote-crepe.md', 'After.')
  // Whatever the note holds by now — the test above writes a line into it — nothing below adds to
  // it: an arrow key only makes a block where there is no position to move to.
  const before = await blockNames(page)

  // Second line of the quote: what is above it is its own first line, which the caret can reach.
  await caretInQuote(page, 1)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(300)
  expect(await blockNames(page)).toEqual(before)

  // And down out of the last line lands in the paragraph under it, which is also reachable.
  await caretInQuote(page, 1)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(300)
  expect(await blockNames(page)).toEqual(before)
})

/**
 * A quote is a wall too.
 *
 * Its lines take an ordinary caret, so leaving one always worked — but there was no way to make a
 * line *between* a quote and a fence, or between two quotes, because the arrow that would go there
 * steps into the next block instead. Reported after the same thing had been fixed for the other two.
 */
async function caretInQuoteLine(page: Page, index: number, end: boolean) {
  await page.locator('.ink-doc blockquote p').nth(index).click()
  await page.keyboard.press(end ? 'End' : 'Home')
  await page.waitForTimeout(250)
}

test('down opens a line between a quote and a fence', async ({ page }) => {
  await openNote(page, 'quotewall-crepe.md', 'After.')
  await caretInQuoteLine(page, 0, true)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('between')
  await page.waitForTimeout(400)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  // The word is its own line, not a line of the code.
  expect(await noteText(page, 'notes/quotewall-crepe.md')).toContain('\n\nbetween\n\n```js')
})

test('and between two quotes', async ({ page }) => {
  await openNote(page, 'quotewall-crepe.md', 'After.')
  // The second quote's own first line is where Up is asked from.
  await page.locator('.ink-doc blockquote').last().locator('p').first().click()
  await page.keyboard.press('Home')
  await page.waitForTimeout(250)
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('gap')
  await page.waitForTimeout(400)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  expect(await noteText(page, 'notes/quotewall-crepe.md')).toContain('\n\ngap\n\n> another quote')
})

/**
 * Backspace at the start of a quote or a fence takes the block and keeps what was in it.
 *
 * Both did nothing at all before: in a quote ProseMirror had nowhere to join the first paragraph
 * *to*, and in a fence the key never left CodeMirror, which has no answer for Backspace at the
 * first column. So the two blocks whose whole job is to wrap something were the two that could not
 * be unwrapped.
 */
test('backspace at the start of a quote unwraps the whole quote', async ({ page }) => {
  await openNote(page, 'unwrap-crepe.md', 'After.')
  await expect(page.locator('.ink-doc blockquote')).toHaveCount(1)

  await caretInQuoteLine(page, 0, false)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(400)

  await expect(page.locator('.ink-doc blockquote')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  const saved = await noteText(page, 'notes/unwrap-crepe.md')
  // Both lines survive, neither is quoted.
  expect(saved).toContain('first quoted line')
  expect(saved).toContain('second quoted line')
  expect(saved).not.toContain('> first quoted line')
})

test('backspace at the start of a fence turns its lines into text', async ({ page }) => {
  await openNote(page, 'unwrap-crepe.md', 'After.')
  await caretInFence(page, 0)
  await page.keyboard.press('Home')
  await page.waitForTimeout(250)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(400)

  await expect(page.locator('.ink-doc .milkdown-code-block')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  const saved = await noteText(page, 'notes/unwrap-crepe.md')
  expect(saved).toContain('const x = 1')
  expect(saved).toContain('const y = 2')
  expect(saved).not.toContain('```')
})
