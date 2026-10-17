import { expect, test, type Page } from '@playwright/test'

/**
 * The note is written the way it was typed, and copied the way it reads.
 *
 * `markdown-escapes.ts` exists because a serialiser protects every character that *could* begin
 * something, and a vault kept in git shows every one of those backslashes to a person who did not
 * type them. This is the test that says which characters are safe to leave alone — and it is a
 * round trip rather than a list of cases, because the way this goes wrong is a character nobody
 * thought to list.
 *
 * The clipboard is here too, and not by analogy: `clipboardTextSerializer` fetches the same
 * `serializerCtx`, so a character escaped on the way to the file is escaped on the way to the
 * clipboard. That is how this was found — reported as "复制出去 _ 就变成 \\_ 了", with nothing
 * visibly wrong in the document.
 */

const FILE = 'notes/escapes-crepe.md'

async function open(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^escapes-crepe\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('snake_case_name', { timeout: 15_000 })
}

const read = (page: Page) => page.evaluate(async (at) => {
  const res = await fetch(`/api/file?path=${encodeURIComponent(at)}`)
  return (await res.json() as { content: string }).content
}, FILE)

test('punctuation in prose survives a save, byte for byte', async ({ page }) => {
  await open(page)
  const before = await read(page)

  // Dirty without changing: a character typed and taken straight back. What is saved is then the
  // serialiser's opinion of the note, which is the thing under test.
  await page.locator('.ink-doc p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.type('z')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(600)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(1200)

  const after = await read(page)
  // Byte for byte. A diff of one line is a backslash in somebody's note.
  expect(after).toBe(before)
})

test('copying carries the characters, not their escapes', async ({ page }) => {
  await open(page)

  await page.evaluate(() => {
    /*
     * Across two paragraphs, deliberately.
     *
     * A selection inside one text node takes `plugin-clipboard`'s `isPureText` shortcut, which
     * copies the characters with `textBetween` and never reaches the serialiser — so a test that
     * selects one line passes whether or not the escapes are fixed. It did. What was reported was
     * copying a region, which is this.
     */
    const blocks = Array.from(document.querySelectorAll('.ink-doc p'))
    const from = blocks.find((p) => (p.textContent ?? '').includes('snake_case_name'))
    const to = blocks.find((p) => (p.textContent ?? '').includes('AT&T'))
    if (from === undefined || to === undefined) throw new Error('the lines are not on screen')
    const range = document.createRange()
    range.setStartBefore(from)
    range.setEndAfter(to)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.addEventListener('copy', (e) => {
      ;(globalThis as Record<string, unknown>).__copied =
        (e as ClipboardEvent).clipboardData!.getData('text/plain')
    }, { once: true })
  })
  // A real keypress: `execCommand('copy')` fires the event with nothing in it, which this suite
  // has now been bitten by twice.
  await page.keyboard.press('ControlOrMeta+c')
  const copied = await page.evaluate(() => (globalThis as Record<string, unknown>).__copied as string)

  expect(copied, 'nothing reached the clipboard').toBeTruthy()
  expect(copied, 'the clipboard carried the serialiser’s escapes')
    .toContain('snake_case_name and a_b_c')
  expect(copied).toContain('AT&T, 100% sure, C# and F#')
  expect(copied).not.toContain('\\_')
  expect(copied).not.toContain('\\&')
})

/**
 * What stays escaped, and why.
 *
 * Unescaping is not free everywhere: a line-leading `-` or `#` is a block, and a block appearing
 * where somebody typed a character is a different order of wrong. This pins the boundary so a
 * later sweep cannot quietly widen it.
 */
test('a character that would become a block keeps its backslash', async ({ page }) => {
  await open(page)
  await page.locator('.ink-doc p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  // Typed with the backslash, because typing `- ` alone makes a list: this is a reader who wants
  // the character and said so.
  await page.keyboard.type('\\- not a bullet')
  await page.waitForTimeout(600)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(1200)

  const saved = await read(page)
  expect(saved, 'the dash lost its escape and became a list').toContain('\\- not a bullet')
})
