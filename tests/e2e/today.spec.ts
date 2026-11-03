import { expect, test, type Page } from '@playwright/test'

/**
 * The Today action: open today's section in a note kept by date, and put the caret in it.
 *
 * What is worth testing here is not that a heading appears — it is *where*. The order is read from
 * the note, so the same action puts today at the top of one file and the bottom of another, and
 * getting that backwards writes the day into the wrong end of somebody's journal. Both directions
 * are exercised against the saved markdown, because the rendered document would look right either
 * way round.
 *
 * The caret is tested the way the reader experiences it: by typing. A selection assertion would
 * pass on a caret that the editor has not focused.
 */

const today = (() => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
})()

async function open(page: Page, note: string, first: string) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText(first, { timeout: 15_000 })
}

/** The action, from the tree row's menu — the entry point a desktop has. */
async function pressToday(page: Page, note: string) {
  const row = page.locator('.ink-tree-row').filter({ hasText: note })
  await row.hover()
  await page.getByRole('button', { name: `Actions for ${note}` }).click()
  await page.getByText('Today', { exact: true }).click()
  await expect(page.locator('.ink-doc h2').filter({ hasText: today })).toHaveCount(1)
}

const read = (page: Page, at: string) => page.evaluate(async (path) => {
  const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`)
  return (await res.json() as { content: string }).content
}, at)

async function save(page: Page) {
  await page.waitForTimeout(600)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(1200)
}

test('a note whose days descend gets today above the newest one', async ({ page }) => {
  await open(page, 'journal-desc.md', 'earlier')
  await pressToday(page, 'journal-desc.md')

  // Typed, not asserted: this is the whole point of the action — the note is ready to write in.
  await page.keyboard.type('wrote this')
  await save(page)

  const saved = await read(page, 'notes/journal-desc.md')
  const days = saved.split('\n').filter((line) => line.startsWith('## '))
  expect(days, 'today went to the wrong end of a newest-first note')
    .toEqual([`## ${today}`, '## 2020-01-05', '## 2020-01-01'])
  expect(saved, 'what was typed did not land under today').toContain(`## ${today}\n\nwrote this`)
})

test('a note whose days ascend gets today after the newest one', async ({ page }) => {
  await open(page, 'journal-asc.md', 'earlier')
  await pressToday(page, 'journal-asc.md')

  await page.keyboard.type('wrote this')
  await save(page)

  const saved = await read(page, 'notes/journal-asc.md')
  const days = saved.split('\n').filter((line) => line.startsWith('## '))
  expect(days, 'today went to the wrong end of an oldest-first note')
    .toEqual(['## 2020-01-01', '## 2020-01-05', `## ${today}`])
  expect(saved, 'what was typed did not land under today').toContain(`## ${today}\n\nwrote this`)
})

test('pressing it twice jumps to today rather than writing a second heading', async ({ page }) => {
  await open(page, 'journal-twice.md', 'earlier')
  await pressToday(page, 'journal-twice.md')
  await page.keyboard.type('first')

  // The caret is sent somewhere else first, so a jump is distinguishable from doing nothing.
  await page.locator('.ink-doc li').last().click()
  await pressToday(page, 'journal-twice.md')
  await page.keyboard.type(' and second')
  await save(page)

  const saved = await read(page, 'notes/journal-twice.md')
  const days = saved.split('\n').filter((line) => line.startsWith('## '))
  expect(days.filter((day) => day === `## ${today}`), 'the day was written twice').toHaveLength(1)
  // At the end of the section, not back at the heading: typing continues where the day left off.
  expect(saved, 'the caret did not land at the end of today').toContain('first and second')
})
