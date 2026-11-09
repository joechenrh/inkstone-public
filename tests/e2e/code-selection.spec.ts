import { expect, test } from '@playwright/test'

const path = 'notes/code-selection.md'
const code = 'const x = 1\nconst y = 2'
const source = `Before.\n\n\`\`\`js\n${code}\n\`\`\`\n\nAfter.\n`

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter', exact: true }).click()
  await page.request.post('/api/file', { data: { path, kind: 'file' } })
  await page.request.put('/api/file', { data: { path, content: source } })
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^code-selection\.md$/ }).click()
  await expect(page.locator('.cm-content')).toContainText('const x = 1')
})

test.afterEach(async ({ page }) => { await page.request.delete(`/api/file?path=${encodeURIComponent(path)}`) })

for (const key of ['Backspace', 'Delete']) {
  test(`selecting all code then ${key} clears the code and retains its block`, async ({ page }) => {
    const block = page.locator('.milkdown-code-block')
    await page.locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+a')
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(code)
    await page.keyboard.press(key)
    await expect(block).toHaveCount(1)
    await expect(page.locator('.cm-content')).toHaveText('')
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(async () => (await (await page.request.get(`/api/file?path=${encodeURIComponent(path)}`)).json()).content)
      .toMatch(/^Before\.\n\n```js\n(?:\n)?```\n\nAfter\.\n$/)
    await page.locator('.cm-content').click()
    await page.keyboard.type('replacement')
    await expect(block).toHaveCount(1)
    await expect(page.locator('.cm-content')).toHaveText('replacement')
  })
}

for (const theme of ['drake', 'lapis', 'everforest']) {
  test(`language search has one focus treatment in ${theme}`, async ({ page }) => {
    await page.evaluate((theme) => {
      localStorage.setItem('inkstone.docTheme', theme)
      localStorage.setItem('inkstone.theme', theme === 'everforest' ? 'dark' : 'light')
    }, theme)
    await page.reload()
    await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
    await page.locator('.ink-tree-name').filter({ hasText: /^code-selection\.md$/ }).click()
    const block = page.locator('.milkdown-code-block')
    await block.hover()
    await block.locator('.language-button').click()
    const search = page.getByPlaceholder('Search language')
    await search.focus()
    await expect(search).toHaveCSS('outline-style', 'none')
    await expect(search).toHaveCSS('box-shadow', 'none')
    await expect(block.locator('.search-box')).toHaveCSS('outline-style', 'none')
    await expect(block.locator('.search-box')).toHaveCSS('border-top-width', '1px')
    await expect(search).toHaveCSS('border-top-width', '0px')
    await search.fill('typescript')
    await expect(page.locator('.language-list-item').filter({ hasText: /typescript/i })).toBeVisible()
    await block.locator('.language-picker').screenshot({ path: `/tmp/inkstone-${theme}-language-search.png` })
  })
}

test('a partial selection at the start deletes text rather than unwrapping the block', async ({ page }) => {
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Backspace')
  await expect(page.locator('.milkdown-code-block')).toHaveCount(1)
  await expect(page.locator('.cm-line').first()).toHaveText('onst x = 1')
})

test('undo restores code after deleting a full code selection', async ({ page }) => {
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await expect(page.locator('.cm-content')).toHaveText('')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.milkdown-code-block')).toHaveCount(1)
  await expect(page.locator('.cm-line')).toHaveText(['const x = 1', 'const y = 2'])
})
