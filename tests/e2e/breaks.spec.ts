import { expect, test, type Page } from '@playwright/test'

/**
 * Line breaks, in the engine that could not hold one.
 *
 * Two defects, found together and worth keeping apart. Shift+Enter made a *paragraph*, so there
 * was no way to write two tight lines — and, worse, a hard break that was already in a note was
 * destroyed by any save: `lute.VditorIRDOM2Md('<p>A<br>B</p>')` returns a soft break, measured at
 * the source. Two lines silently became one, wherever the note was read next.
 */

async function open(page: Page, engine: 'vditor' | 'crepe', note: string) {
  await page.addInitScript((e) => { localStorage.setItem('inkstone.editorEngine', e) }, engine)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText('holds', { timeout: 15_000 })
}

const read = (page: Page, path: string) => page.evaluate(async (p) => {
  const res = await fetch(`/api/file?path=${encodeURIComponent(p)}`)
  return (await res.json() as { content: string }).content
}, path)

const write = (page: Page, path: string, content: string) => page.evaluate(async ([p, c]) => {
  await fetch('/api/file', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: p, content: c }),
  })
}, [path, content])

/**
 * A hard break, in the engine that can hold one.
 *
 * Measured at the source while looking at line spacing: `lute.VditorIRDOM2Md('<p>A<br>B</p>')`
 * returns a *soft* break, and that engine re-serialises a block on every keystroke — so a line
 * break cannot be written there, and one that is already in a note does not survive being edited.
 * Recorded in `docs/design/editor.md` rather than worked around: a keystroke that silently
 * produces something the engine will destroy is worse than no keystroke.
 */
test('crepe: a hard break already in a note survives a save', async ({ page }) => {
  await open(page, 'crepe', 'breaks.md')
  const before = await read(page, 'notes/breaks.md')
  expect(before).toContain('A\\\n')

  await page.locator('.ink-doc').getByText('holds', { exact: false }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await page.waitForTimeout(600)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)

  const after = await read(page, 'notes/breaks.md')
  expect(after).toContain('A\\\n')
  expect(after).toContain('!')

  await write(page, 'notes/breaks.md', before)
})

/** And can make one. */
test('crepe: shift+enter breaks the line and keeps the paragraph', async ({ page }) => {
  await open(page, 'crepe', 'breaks.md')
  const before = await read(page, 'notes/breaks.md')

  await page.locator('.ink-doc').getByText('holds', { exact: false }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('second')
  await page.waitForTimeout(600)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)

  const after = await read(page, 'notes/breaks.md')
  // A hard break, the spelling github.com reads as a line break.
  expect(after).toMatch(/\\\nsecond/)
  // And not a paragraph, which is what it used to make.
  expect(after).not.toMatch(/\n\nsecond/)

  await write(page, 'notes/breaks.md', before)
})

test('a line break is tighter than a paragraph, by the height of the gap', async ({ page }) => {
  // The reason any of this matters: one keystroke gives 26px, the other 38px, and before this there
  // was only the second.
  await open(page, 'crepe', 'breaks.md')
  const pitches = await page.evaluate(() => {
    const lines = (el: Element) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return Array.from(range.getClientRects()).filter((r) => r.height > 6)
    }
    const ps = Array.from(document.querySelectorAll('.ink-doc > p'))
    const broken = ps.find((p) => p.querySelector('br'))!
    const two = lines(broken)
    return {
      withinParagraph: Math.round(two[1]!.top - two[0]!.top),
      betweenParagraphs: Math.round(ps[1]!.getBoundingClientRect().top - ps[0]!.getBoundingClientRect().top),
    }
  })
  expect(pitches.withinParagraph).toBeLessThan(pitches.betweenParagraphs)
})
