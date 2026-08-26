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
