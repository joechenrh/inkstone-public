import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Finding a note.
 *
 * Search runs **in the browser**. It used to ask the server on every keystroke, and that is why it
 * felt slow next to VS Code and Typora — those search local data. Everything the old design needed
 * to survive a network round trip went with it: the debounce, the stale-response guard, the
 * "Searching…" state that emptied the list it was about to refill, and a two-character minimum
 * invented to keep the cost down, which made "1" find nothing and "11" find something.
 *
 * The vault's text is fetched once and searched in memory. Measured on the real vault: 2,271 bytes.
 */

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

async function login(page: Page) {
  await useVditor(page)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await expect(page.locator('.ink-search-input')).toBeVisible({ timeout: 15_000 })
  // The field renders before the tree data arrives, so waiting on it is not waiting for the tree.
  await expect(page.locator('.ink-tree-name').first()).toBeVisible({ timeout: 15_000 })
}

const groups = (page: Page) =>
  page.evaluate(() => Array.from(document.querySelectorAll('.ink-search-group'), (e) => e.textContent))

test('typing searches names and text together, with no second key', async ({ page }) => {
  await login(page)
  await page.locator('.ink-search-input').fill('blockquote')

  // Nothing is named "blockquote"; rich.md contains it. One group, and nothing to press.
  await expect.poll(() => groups(page)).toEqual(['In the text'])
  const hit = page.locator('.ink-search-hit').first()
  await expect(hit.locator('mark')).toHaveText('blockquote')
  await hit.click()
  await expect(page.locator('.ink-breadcrumb')).toContainText('.md')
})

test('a name match and a text match are told apart', async ({ page }) => {
  await login(page)
  await page.locator('.ink-search-input').fill('rich')
  await expect.poll(() => groups(page)).toContain('Notes')
  await expect(page.locator('.ink-search-hit').first().locator('.ink-search-hit-name'))
    .toHaveText('rich.md')
})

test('the vault is fetched once, and never again while typing', async ({ page }) => {
  await login(page)
  const asked: string[] = []
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/corpus') asked.push(r.url())
  })

  await page.locator('.ink-search-input').pressSequentially('blockquote', { delay: 25 })
  await expect(page.locator('.ink-search-hit').first()).toBeVisible()
  await page.locator('.ink-search-input').fill('table')
  await page.locator('.ink-search-input').fill('heading')
  await page.waitForTimeout(300)

  expect(asked.length, 'one fetch, then memory').toBe(1)
})

test('one character searches the text, like any other number of them', async ({ page }) => {
  await login(page)
  // The two-character minimum existed to keep the request count down. It meant "1" found nothing
  // in the text and "11" found something, which is not a rule anyone could guess.
  await page.locator('.ink-search-input').fill('#')
  await expect(page.locator('.ink-search-hit').first()).toBeVisible()
})

test('changing the query never empties the list it is about to refill', async ({ page }) => {
  await login(page)
  await page.locator('.ink-search-input').fill('block')
  await expect(page.locator('.ink-search-hit').first()).toBeVisible()

  // Every intermediate state has results. The old design cleared them and showed "Searching the
  // text…" until the next response landed, which over a slow link read as a flash and then nothing.
  for (const q of ['blockq', 'blockqu', 'blockquo', 'blockquote']) {
    await page.locator('.ink-search-input').fill(q)
    await expect(page.locator('.ink-search-hit').first()).toBeVisible({ timeout: 1000 })
  }
})

test('a saved edit is findable', async ({ page }) => {
  await login(page)
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^welcome\.md$/ }).click()
  await expect(page.locator('.vditor-ir pre[contenteditable="true"]')).toBeVisible({ timeout: 15_000 })

  await page.locator('.vditor-ir .vditor-reset').click()
  await page.keyboard.press('ControlOrMeta+ArrowDown')
  await page.keyboard.type('\nzimbabwe')
  await page.keyboard.press('ControlOrMeta+s')

  // The copy search holds is dropped when the vault changes, and refetched on the next search.
  await page.locator('.ink-search-input').fill('zimbabwe')
  await expect(page.locator('.ink-search-hit').first()).toBeVisible({ timeout: 10_000 })
})

test('nothing matching says so in one line', async ({ page }) => {
  await login(page)
  await page.locator('.ink-search-input').fill('zzqq-nothing')
  await expect(page.locator('.ink-search-note')).toHaveText('Nothing matches “zzqq-nothing”.')
})

test('the highlighted word is visible in its own row', async ({ page }) => {
  await login(page)
  await page.locator('.ink-search-input').fill('blockquote')
  await expect(page.locator('.ink-search-hit').first()).toBeVisible()

  // The excerpt is one clipped line in a 250px panel: too much context in front of the match
  // pushes the highlighted word off the end of the row it is the reason for.
  const visible = await page.locator('.ink-search-hit-line').first().evaluate((line) => {
    const mark = line.querySelector('mark')
    if (!mark) return false
    const l = line.getBoundingClientRect()
    const m = mark.getBoundingClientRect()
    return m.left >= l.left - 1 && m.right <= l.right + 1
  })
  expect(visible).toBe(true)
})

test('the field shows focus without drawing a second box around itself', async ({ page }) => {
  await login(page)
  await page.locator('.ink-search-input').focus()

  const focus = await page.evaluate(() => {
    const field = getComputedStyle(document.querySelector('.ink-search')!)
    const input = getComputedStyle(document.querySelector('.ink-search-input')!)
    return { halo: field.boxShadow !== 'none', ring: input.outlineStyle }
  })
  expect(focus.halo, 'the field carries the focus').toBe(true)
  expect(focus.ring, 'the input inside it must not draw its own ring').toBe('none')
})

test('a text hit lands on the match, not the top of the note', async ({ page }) => {
  await login(page)
  await page.locator('.ink-search-input').fill('blockquote')
  await page.locator('.ink-search-hit').first().click()
  await expect(page.locator('.vditor-ir .vditor-reset')).toBeVisible({ timeout: 15_000 })

  await expect.poll(async () => page.evaluate(() => document.getSelection()?.toString() ?? ''),
    { timeout: 10_000 }).toBe('blockquote')

  const inView = await page.evaluate(() => {
    const root = document.querySelector('.vditor-ir .vditor-reset')!.getBoundingClientRect()
    const sel = document.getSelection()!
    if (!sel.rangeCount) return false
    const r = sel.getRangeAt(0).getBoundingClientRect()
    return r.top >= root.top - 2 && r.bottom <= root.bottom + 2
  })
  expect(inView).toBe(true)
})

test('a note matching by name and by text keeps its excerpt', async ({ page }) => {
  await login(page)
  // hello.md is named "hello" and its text is "# hello", so it matches both ways.
  await page.locator('.ink-search-input').fill('hello')
  const first = page.locator('.ink-search-hit').first()
  await expect(first.locator('.ink-search-hit-name')).toHaveText('hello.md')
  await expect(first.locator('.ink-search-hit-line')).toContainText('hello')
})

test('clearing brings the tree back', async ({ page }) => {
  await login(page)
  const before = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ink-tree-name'), (e) => e.textContent))

  await page.locator('.ink-search-input').fill('rich')
  await expect(page.locator('.ink-search-hit').first()).toBeVisible()
  await expect(page.locator('.ink-tree-name')).toHaveCount(0)

  await page.locator('.ink-search-clear').click()
  await expect.poll(() => page.evaluate(() =>
    Array.from(document.querySelectorAll('.ink-tree-name'), (e) => e.textContent))).toEqual(before)
})
