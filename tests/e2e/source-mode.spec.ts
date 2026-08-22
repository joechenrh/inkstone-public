import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Source mode: the raw markdown, for the edits the renderer is in the way of.
 *
 * The rule these tests exist to hold is the one that makes the mode worth having. Editing anything
 * in the rendered view makes lute re-serialise the whole document — table cells padded, delimiter
 * row rewritten, a blank line inserted above. That is fine and already happens. What must not
 * happen is text typed *as source* coming back rewritten, so nothing is pushed through the
 * renderer while this mode is open.
 */

async function openTight(page: Page) {
  await useVditor(page)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^tight\.md$/ }).click()
  await expect(page.locator('.vditor-ir .vditor-reset table')).toBeVisible({ timeout: 15_000 })
}

const source = (page: Page) => page.locator('.ink-source-area')

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

test('Cmd+Alt+M shows the markdown exactly as it is on disk', async ({ page }) => {
  await openTight(page)
  await expect(page.locator('.ink-source')).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+Alt+KeyM')
  await expect(source(page)).toBeVisible()

  // The tight table is the point: this is the file's own text, not lute's rewrite of it.
  const text = await source(page).inputValue()
  expect(text).toContain('|Left|Centre|')
  expect(text).not.toContain('| :--- |')

  await page.keyboard.press('ControlOrMeta+Alt+KeyM')
  await expect(page.locator('.ink-source')).toHaveCount(0)
})

test('the gutter numbers the lines and scrolls with the text', async ({ page }) => {
  await openTight(page)
  await page.keyboard.press('ControlOrMeta+Alt+KeyM')
  await expect(source(page)).toBeVisible()

  const lines = (await source(page).inputValue()).split('\n').length
  await expect(page.locator('.ink-source-gutter div')).toHaveCount(lines)
  await expect(page.locator('.ink-source-gutter div').first()).toHaveText('1')

  // One logical line is one row — the textarea does not wrap — so the two can be compared
  // directly. With wrapping on they drifted: 346px of text against 273px of gutter.
  await source(page).evaluate((el: HTMLTextAreaElement) => { el.scrollTop = el.scrollHeight })
  await expect.poll(() => page.evaluate(() => {
    const a = document.querySelector<HTMLTextAreaElement>('.ink-source-area')!
    const g = document.querySelector<HTMLElement>('.ink-source-gutter')!
    return Math.abs(a.scrollTop - g.scrollTop) < 1
  })).toBe(true)
})

test('text typed as source reaches the file exactly as typed', async ({ page }) => {
  await openTight(page)
  await page.keyboard.press('ControlOrMeta+Alt+KeyM')
  await source(page).click()
  await page.keyboard.press('ControlOrMeta+ArrowDown')
  await page.keyboard.type('\n\n|kept|as|typed|\n')
  await page.keyboard.press('ControlOrMeta+s')

  // Back through the renderer once, then out again: the tight table must have survived the trip.
  await page.keyboard.press('ControlOrMeta+Alt+KeyM')
  await expect(page.locator('.vditor-ir .vditor-reset table')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Alt+KeyM')
  const after = await source(page).inputValue()
  expect(after).toContain('|Left|Centre|')
  expect(after).toContain('|kept|as|typed|')
})

test('a source edit shows up in the rendered view', async ({ page }) => {
  await openTight(page)
  await page.keyboard.press('ControlOrMeta+Alt+KeyM')
  await source(page).click()
  await page.keyboard.press('ControlOrMeta+ArrowDown')
  await page.keyboard.type('\n## Added from source\n')

  await page.keyboard.press('ControlOrMeta+Alt+KeyM')
  await expect(page.locator('.vditor-ir .vditor-reset h2')).toContainText('Added from source')
})

// Edit, read and source are one setting with three values, so asking for reading while in source
// leaves source — there is no read-only source view, and no way to be in two at once.
test('the three views are exclusive', async ({ page }) => {
  await openTight(page)
  const lit = () => page.evaluate(() => Array.from(
    document.querySelectorAll('.ink-viewbtn[aria-pressed="true"]'), (b) => b.getAttribute('title')))

  expect(await lit()).toEqual(['Edit (Cmd/Ctrl+E)'])

  await page.keyboard.press('ControlOrMeta+Alt+KeyM')
  await expect(source(page)).toBeVisible()
  expect(await lit()).toEqual(['Markdown source (Cmd/Ctrl+Alt+M)'])

  await page.keyboard.press('ControlOrMeta+e')
  await expect(page.locator('.ink-source')).toHaveCount(0)
  expect(await lit()).toEqual(['Read (Cmd/Ctrl+E)'])

  await page.getByTitle('Edit (Cmd/Ctrl+E)').click()
  expect(await lit()).toEqual(['Edit (Cmd/Ctrl+E)'])
})

// Everything that acts on the open document goes when there is none — the rule source mode
// already followed alone, now applied to the view group, the panel toggle and the word count.
// Settings and the file-tree toggle stay: they are the app, not the file.
test('the document controls are not there when there is no document', async ({ page }) => {
  await useVditor(page)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await expect(page.locator('.ink-empty')).toBeVisible()

  await expect(page.locator('.ink-viewgroup')).toHaveCount(0)
  await expect(page.locator('.ink-statusbar-counts')).toHaveCount(0)
  await expect(page.locator('.ink-topbar button[title*="right panel"]')).toHaveCount(0)
  await expect(page.locator('.ink-topbar button[title="Settings"]')).toBeVisible()
  await expect(page.locator('.ink-topbar button[title*="file tree"]')).toBeVisible()

  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^tight\.md$/ }).click()
  await expect(page.locator('.ink-viewgroup')).toBeVisible()
  await expect(page.locator('.ink-statusbar-counts')).toBeVisible()

  await page.getByTitle('Markdown source (Cmd/Ctrl+Alt+M)').click()
  await expect(source(page)).toBeVisible()
})
