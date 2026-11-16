import { expect, test, webkit } from '@playwright/test'
import type { Page } from '@playwright/test'

const file = 'notes/view-shortcuts.md'
const original = '# View shortcuts\n\nA paragraph with text.\n\n```js\nconst x = 1\n```\n\nThe final paragraph.\n'

async function checkViews(page: Page, modifier: 'Control' | 'Meta', vim: boolean) {
  await page.addInitScript((on) => { localStorage.setItem('inkstone.sourceVim', on ? '1' : '0') }, vim)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.request.put('/api/file', { data: { path: file, content: original } })
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^view-shortcuts\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('The final paragraph.')

  const active = (name: 'Edit' | 'Read' | 'Markdown source') => page.getByRole('button', { name: new RegExp(`^${name} \\(`) })
  await page.locator('.ink-doc p').last().click()
  await page.keyboard.press(`${modifier}+e`)
  await expect(active('Read')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press(`${modifier}+e`)
  await expect(active('Edit')).toHaveAttribute('aria-pressed', 'true')

  // The same command works in a nested CodeMirror fenced-code editor.
  await page.locator('.ink-doc .milkdown-code-block').first().click()
  await expect(page.locator('.ink-doc .cm-content')).toBeVisible()
  await page.locator('.ink-doc .cm-content').click()
  await page.keyboard.press(`${modifier}+m`)
  await expect(active('Markdown source')).toHaveAttribute('aria-pressed', 'true')
  const source = page.locator(vim ? '.ink-source--vim .cm-content' : 'textarea.ink-source-area')
  await source.click()
  await page.keyboard.press(`${modifier}+e`)
  await expect(active('Read')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press(`${modifier}+m`)
  await expect(source).toBeVisible()
  await source.click()
  if (vim) await page.keyboard.type('i')
  await page.keyboard.press(`${modifier}+m`)
  await expect(active('Edit')).toHaveAttribute('aria-pressed', 'true')
  await expect(source).toHaveCount(0)

  // A focused non-editor control behaves identically, and the old source shortcut still works.
  await page.getByRole('button', { name: 'Settings', exact: true }).focus()
  await page.keyboard.press(`${modifier}+m`)
  await expect(source).toBeVisible()
  await page.keyboard.press(`${modifier}+Alt+KeyM`)
  await expect(active('Edit')).toHaveAttribute('aria-pressed', 'true')
  expect((await (await page.request.get(`/api/file?path=${file}`)).json()).content).toBe(original)
  await expect(page.getByRole('img', { name: 'Unsaved', exact: true })).toHaveCount(0)
}

for (const modifier of ['Control', 'Meta'] as const) {
  for (const vim of [false, true]) {
    test(`${modifier}+E/M override focused rendered, code and ${vim ? 'Vim' : 'plain'} source editors`, async ({ page }) => {
      await checkViews(page, modifier, vim)
    })
  }
}

test('WebKit view shortcuts work inside focused rendered and Vim editors', async () => {
  const browser = await webkit.launch()
  try {
    for (const modifier of ['Control', 'Meta'] as const) {
      const page = await browser.newPage({ baseURL: 'http://127.0.0.1:7699' })
      await checkViews(page, modifier, true)
      await page.close()
    }
  } finally { await browser.close() }
})
