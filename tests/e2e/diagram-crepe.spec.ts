import { expect, test, type Page } from '@playwright/test'

/**
 * A `mermaid` fence draws its diagram.
 *
 * The one capability the other engine had that this one did not, found by rendering the same note
 * in both: Vditor drew the graph and Crepe showed `graph TD`. Crepe's fenced block already has the
 * preview panel the formula block uses, so this is that hook answering one more language.
 */

async function open(page: Page, note: string, expectText: string) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText(expectText, { timeout: 15_000 })
}

test('a mermaid fence draws its diagram, and a js one does not', async ({ page }) => {
  await open(page, 'diagram-crepe.md', 'const x = 1')

  const diagram = page.locator('.ink-mermaid svg')
  await expect(diagram).toHaveCount(1, { timeout: 15_000 })
  // A drawn graph rather than an empty frame: two boxes and the arrow between them.
  expect(await page.locator('.ink-mermaid .node').count()).toBeGreaterThanOrEqual(2)

  // And the source is what you get by going into it, the way the formula block behaves: the code
  // editor is still there, hidden, rather than gone.
  await expect(page.locator('.ink-doc .milkdown-code-block').first().locator('.cm-editor')).toBeHidden()
  await expect(page.locator('.ink-doc .milkdown-code-block').last()).toContainText('const x = 1')
})

/**
 * The labels are HTML inside the SVG, so the document's own paragraph rhythm reaches them: a 12px
 * top margin on a label measured at 24px tall pushed every letter half out of its own box, and `A`
 * read as `∧`. This is the assertion that the reset still wins — the rule it answers is written
 * with `:root[data-doc-theme]` and four repetitions of `.ink-doc`, so it is a specificity contest
 * rather than an `!important` one.
 */
test('a diagram label sits inside its own box', async ({ page }) => {
  await open(page, 'diagram-crepe.md', 'const x = 1')
  await expect(page.locator('.ink-mermaid svg')).toHaveCount(1, { timeout: 15_000 })

  const fits = await page.evaluate(() => {
    const label = document.querySelector('.ink-mermaid .nodeLabel')
    const box = label?.closest('foreignObject')
    if (!label || !box) return null
    const a = label.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    return { top: Math.round(a.top - b.top), bottom: Math.round(b.bottom - a.bottom) }
  })
  expect(fits).not.toBeNull()
  expect(fits!.top).toBeGreaterThanOrEqual(0)
  expect(fits!.bottom).toBeGreaterThanOrEqual(0)
})

/**
 * `mermaid` is on the list of languages a block can be.
 *
 * Crepe fills the picker from `@codemirror/language-data` — 143 languages, and no mermaid, because
 * mermaid is not a CodeMirror language. So a diagram could be turned into C++ and never turned
 * back: the name it needed was not on the list. Reported as exactly that.
 */
test('the language picker offers mermaid, and picking it draws the diagram', async ({ page }) => {
  await open(page, 'diagram-crepe.md', 'const x = 1')

  // The js block at the end, which draws nothing.
  const fence = page.locator('.ink-doc .milkdown-code-block').last()
  await fence.hover()
  await fence.locator('.language-button').click()
  await page.waitForTimeout(400)

  const names = await page.$$eval('.language-list-item', (rows) => rows.map((r) => r.textContent?.trim()))
  expect(names).toContain('mermaid')

  // Picking it is what a reader does with a block that should have been a diagram.
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.language-list-item'))
    const row = rows.find((r) => r.textContent?.trim() === 'mermaid')
    row?.scrollIntoView({ block: 'center' })
    ;(row as HTMLElement | undefined)?.click()
  })
  await page.waitForTimeout(900)

  // The renderer has taken the block over. What it says is that `const x = 1` is not a diagram,
  // which is the right answer and the proof that the language really changed — a fence that is
  // still JavaScript has no preview at all.
  await expect(page.locator('.ink-mermaid-error')).toHaveCount(1, { timeout: 15_000 })
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  const saved = await page.evaluate(async () => {
    const res = await fetch('/api/file?path=notes%2Fdiagram-crepe.md')
    return (await res.json() as { content: string }).content
  })
  expect(saved).not.toContain('```js')
  expect(saved.match(/```mermaid/g)?.length).toBe(2)
})
