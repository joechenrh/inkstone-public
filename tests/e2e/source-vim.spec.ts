import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOC_THEMES } from '../../src/web/theme/docThemes.js'

const file = 'notes/vim-source.md'
const original = '# Vim source\n\nalpha beta gamma\nkeep this line\n\n|Left|Centre|\n|---|---|\n|a|b|\n'
const editor = (page: Page) => page.locator('.ink-source--vim .cm-content')
const status = (page: Page) => page.locator('.ink-source--vim .cm-vim-panel')

async function sourceText(page: Page) {
  return page.locator('.ink-source--vim .cm-line').allTextContents().then((lines) => lines.join('\n'))
}
async function keys(page: Page, text: string) { await page.keyboard.type(text) }
async function command(page: Page, text: string) {
  await keys(page, `:${text}`)
  await page.keyboard.press('Enter')
}
async function chooseKeys(page: Page, value: string) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Source keybindings').selectOption(value)
  await page.getByRole('button', { name: 'Close settings' }).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.request.put('/api/file', { data: { path: file, content: original } })
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^vim-source\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('alpha beta gamma')
  await chooseKeys(page, 'vim')
  await page.getByRole('button', { name: /^Markdown source \(/ }).click()
  await expect(editor(page)).toBeVisible()
  await editor(page).click()
})

test('modal editing, text objects, undo, redo and exact :w persistence', async ({ page }) => {
  await expect(status(page)).toContainText('NORMAL')
  await keys(page, 'ggjj0dw')
  expect(await sourceText(page)).toContain('beta gamma')
  await keys(page, 'u')
  expect(await sourceText(page)).toBe(original)
  await page.keyboard.press('Control+r')
  expect(await sourceText(page)).toContain('beta gamma')
  await keys(page, 'u')
  await keys(page, 'ciw')
  await expect(status(page)).toContainText('INSERT')
  await page.keyboard.insertText('changed 中文')
  await page.keyboard.press('Escape')
  await expect(status(page)).toContainText('NORMAL')
  await command(page, 'w')
  const expected = original.replace('alpha', 'changed 中文')
  await expect.poll(async () => (await (await page.request.get(`/api/file?path=${file}`)).json()).content).toBe(expected)
  await page.getByRole('button', { name: /^Edit \(/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('changed 中文 beta gamma')
  await page.getByRole('button', { name: /^Markdown source \(/ }).click()
  expect(await sourceText(page)).toBe(expected)
})

test('visual selection, search, substitution, registers and macros', async ({ page }) => {
  await keys(page, 'ggjj0viw')
  await expect(status(page)).toContainText('VISUAL')
  await keys(page, 'y$p')
  expect(await sourceText(page)).toContain('alpha beta gammaalpha')
  await keys(page, 'u')
  await keys(page, '/keep')
  await page.keyboard.press('Enter')
  await keys(page, 'ciw')
  await keys(page, 'saved')
  await page.keyboard.press('Escape')
  expect(await sourceText(page)).toContain('saved this line')
  await command(page, '%s/beta/BETA/g')
  expect(await sourceText(page)).toContain('alpha BETA gamma')
  await keys(page, 'ggqaA!')
  await page.keyboard.press('Escape')
  await keys(page, 'qj@a')
  expect(await sourceText(page)).toContain('# Vim source!\n!\n')
})

test('view shortcuts override Vim while escape and saved preference keep working', async ({ page }) => {
  await keys(page, 'i')
  await page.keyboard.press('Control+BracketLeft')
  await expect(status(page)).toContainText('NORMAL')
  await page.keyboard.press('Control+e')
  await expect(editor(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Read \(/ })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ControlOrMeta+KeyM')
  await expect(editor(page)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+KeyM')
  await expect(editor(page)).toHaveCount(0)
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^vim-source\.md$/ }).click()
  await page.getByRole('button', { name: /^Markdown source \(/ }).click()
  await expect(editor(page)).toBeVisible()
  await chooseKeys(page, 'standard')
  await expect(page.locator('textarea.ink-source-area')).toHaveValue(original)
  await chooseKeys(page, 'vim')
  expect(await sourceText(page)).toBe(original)
})

test('switching notes and external reloads never leak content or undo history', async ({ page }) => {
  await keys(page, 'A changed')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await (await page.request.get(`/api/file?path=${file}`)).json()).content).toContain('changed')
  await page.locator('.ink-tree-name').filter({ hasText: /^hello\.md$/ }).click()
  await expect(editor(page)).toContainText('# hello')
  await editor(page).click()
  await keys(page, 'u')
  expect(await sourceText(page)).toBe('# hello\n')
  await keys(page, 'ggA there')
  await page.keyboard.press('Escape')
  await command(page, 'w')
  await expect.poll(async () => (await (await page.request.get('/api/file?path=notes/hello.md')).json()).content).toBe('# hello there\n')
  // Restore the shared fixture for other source-mode tests.
  const { root } = await (await page.request.get('/api/vault/info')).json()
  expect(path.basename(root)).toMatch(/^inkstone-e2e-/)
  // Let the watcher's documented self-write suppression window expire, then edit externally.
  await page.waitForTimeout(2100)
  await fs.writeFile(path.join(root, 'notes/hello.md'), '# hello\n')
  await expect.poll(() => sourceText(page)).toBe('# hello\n')
  await editor(page).click()
  await keys(page, 'u')
  expect(await sourceText(page)).toBe('# hello\n')
})

test('failed :w retains the draft and source is usable at desktop and phone widths', async ({ page }) => {
  await keys(page, 'ggA unsaved')
  await page.keyboard.press('Escape')
  await page.route('**/api/file', (route) => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, json: { error: 'Save unavailable' } }) : route.continue())
  await command(page, 'w')
  await expect(page.getByText('Save unavailable', { exact: false })).toBeVisible()
  expect(await sourceText(page)).toContain('# Vim source unsaved')
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 })
    if (width < 600) {
      await page.locator('.ink-tree-name').filter({ hasText: /^vim-source\.md$/ }).click()
      await page.getByTitle('Source', { exact: true }).click()
    }
    await expect(status(page)).toBeVisible()
    const bounds = await page.locator('.ink-source--vim').boundingBox()
    expect(bounds!.width).toBeGreaterThan(100)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: `/tmp/inkstone-vim-${width}.png` })
  }
})

test('long notes preserve the caret block on entering and leaving Vim source', async ({ page }) => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i + 1} with some text.`).join('\n\n')
  await keys(page, 'ggVGc')
  await page.keyboard.insertText(paragraphs)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Edit \(/ }).click()
  await expect(page.locator('.ink-doc > p')).toHaveCount(40)
  // Wait for source-to-rendered caret restoration before making the next real selection.
  await expect(page.locator('.ink-doc')).toBeFocused()
  await page.locator('.ink-doc > p').nth(19).click()
  await page.keyboard.press('ControlOrMeta+KeyM')
  await expect(editor(page)).toBeVisible()
  await expect.poll(() => page.locator('.ink-source--vim .cm-scroller').evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  // The first edit identifies the line under the restored caret.
  await keys(page, 'Ilanded ')
  await page.keyboard.press('Escape')
  await expect(editor(page)).toContainText('landed Paragraph number 20')
  await keys(page, '/Paragraph number 7 ')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+KeyM')
  await expect.poll(() => page.evaluate(() => {
    const node = getSelection()?.focusNode
    return (node instanceof Element ? node : node?.parentElement)?.closest('.ink-doc > *')?.textContent
  })).toContain('Paragraph number 7 ')
})

test('Vim command and search prompts keep a text caret without a form focus ring', async ({ page }) => {
  for (const prefix of [':', '/', '?']) {
    await keys(page, prefix)
    const input = page.locator('.ink-source--vim .cm-vim-panel input')
    await expect(input).toBeFocused()
    await page.screenshot({ path: `/tmp/inkstone-vim-prompt-${prefix === ':' ? 'command' : prefix === '/' ? 'search' : 'reverse'}.png` })
    for (const theme of DOC_THEMES) {
      for (const appearance of theme.appearances) {
        await page.evaluate(({ id, appearance }) => {
          document.documentElement.setAttribute('data-doc-theme', id)
          document.documentElement.setAttribute('data-theme', appearance)
        }, { id: theme.id, appearance })
        await expect(input).toHaveCSS('outline-style', 'none')
        await expect(input).toHaveCSS('box-shadow', 'none')
        await expect(input).toHaveCSS('border-top-width', '0px')
        expect((await status(page).boundingBox())!.height).toBeLessThan(40)
      }
    }
    await keys(page, prefix === ':' ? 'w' : 'beta')
    await expect(input).toHaveValue(prefix === ':' ? 'w' : 'beta')
    await page.keyboard.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(editor(page)).toBeFocused()
    await expect(status(page)).toContainText('NORMAL')
    await expect(editor(page)).toHaveCSS('outline-style', 'none')
  }
  expect(await sourceText(page)).toBe(original)
  // The exception belongs to the editor surfaces; ordinary controls retain keyboard feedback.
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  await settings.focus()
  await expect(settings).toHaveCSS('outline-style', 'solid')
})
