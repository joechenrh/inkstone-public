import { expect, test } from '@playwright/test'

const path = 'notes/code-theme.md'
const source = 'Before.\n\n```js\n// sample comment\nconst message = "hello";\nfunction greet(name) { return 42; }\nconsole.log(message);\n```\n\nAfter.\n'
const palettes: [string, string, string, string][] = [
  ['lapis', 'light', '#d73a49', '#032f62'],
  ['lapis', 'dark', '#d73a49', '#032f62'],
  ['plain', 'light', '#d73a49', '#032f62'],
  ['plain', 'dark', '#d73a49', '#032f62'],
  ['forest', 'light', '#d73a49', '#032f62'],
  ['drake', 'light', '#cc7832', '#6a8759'],
  ['aspartate', 'dark', '#e6cd69', '#55b5db'],
  ['everforest', 'light', '#f85552', '#8da101'],
  ['everforest', 'dark', '#e67e80', '#a7c080'],
  ['bitclean', 'light', '#8839ef', '#40a02b'],
  ['bitclean', 'dark', '#cba6f7', '#a6e3a1'],
  ['tailwind', 'light', '#f472b5', '#7dd4fc'],
  ['tailwind', 'dark', '#f472b5', '#7dd4fc'],
]
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter', exact: true }).click()
  await page.request.post('/api/file', { data: { path, kind: 'file' } })
  await page.request.put('/api/file', { data: { path, content: source } })
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^code-theme\.md$/ }).click()
  await expect(page.locator('.cm-content')).toContainText('const message')
})

test.afterEach(async ({ page }) => { await page.request.delete(`/api/file?path=${encodeURIComponent(path)}`) })

test('each theme overrides native syntax colours and themes without a palette keep the default', async ({ page }) => {
  for (const [theme, mode, keyword, string] of palettes) {
    await page.evaluate(({ theme, mode }) => {
      document.documentElement.dataset.docTheme = theme
      document.documentElement.dataset.theme = mode
    }, { theme, mode })
    await expect(page.locator('.cm-keyword').filter({ hasText: /^const$/ })).toHaveCSS('color', rgb(keyword))
    await expect(page.locator('.cm-string').filter({ hasText: /^"hello"$/ })).toHaveCSS('color', rgb(string))
    if (['drake', 'everforest', 'lapis'].includes(theme)) {
      await page.locator('.milkdown-code-block').screenshot({ path: `/tmp/inkstone-code-theme-${theme}-${mode}.png` })
    }
  }
  await page.keyboard.press('ControlOrMeta+s')
  const saved = await (await page.request.get(`/api/file?path=${encodeURIComponent(path)}`)).json()
  expect(saved.content).toBe(source)
})

test('a partial palette overrides just one token and changing it retains code edits and undo', async ({ page }) => {
  await page.addStyleTag({ content: '[data-doc-theme="lapis"] .cm-s-inner .cm-keyword { color: #123456; }' })
  await expect(page.locator('.cm-keyword').filter({ hasText: /^const$/ })).toHaveCSS('color', rgb('#123456'))
  await expect(page.locator('.cm-string').filter({ hasText: /^"hello"$/ })).toHaveCSS('color', rgb('#032f62'))
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(' // pending edit')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('.ink-settings-disclosure').click()
  await page.locator('.ink-swatch').filter({ hasText: 'Drake' }).click()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(page.locator('.cm-keyword').filter({ hasText: /^const$/ })).toHaveCSS('color', rgb('#cc7832'))
  await expect(page.locator('.cm-content')).toContainText('// pending edit')
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.cm-content')).not.toContainText('// pending edit')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await (await page.request.get(`/api/file?path=${encodeURIComponent(path)}`)).json()).content).toBe(source)
})

for (const fixture of [
  { language: 'Python', content: 'def greet():\n    return "hello"', keyword: 'return' },
  { language: 'JSON', content: '{"message": "hello", "count": 42}', keyword: null },
]) {
  test(`native palette also applies after switching the language to ${fixture.language}`, async ({ page }) => {
    await page.evaluate(() => { document.documentElement.dataset.docTheme = 'drake' })
    await page.locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText(fixture.content)
    const block = page.locator('.milkdown-code-block')
    await block.hover()
    await block.locator('.language-button').click()
    await page.getByPlaceholder('Search language').fill(fixture.language)
    await page.locator('.language-list-item').filter({ hasText: new RegExp(`^${fixture.language}$`, 'i') }).click()
    await expect(page.locator('.cm-string').filter({ hasText: /^"hello"$/ })).toHaveCSS('color', rgb('#6a8759'))
    if (fixture.keyword) {
      await expect(page.locator('.cm-keyword').filter({ hasText: fixture.keyword })).toHaveCSS('color', rgb('#cc7832'))
    } else {
      await expect(page.locator('.cm-property').first()).toHaveCSS('color', rgb('#ffc66d'))
    }
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(async () => (await (await page.request.get(`/api/file?path=${encodeURIComponent(path)}`)).json()).content)
      .toContain(fixture.content)
  })
}

test('code caret contrasts with its own surface in every theme appearance', async ({ page }) => {
  await page.locator('.cm-content').click()
  await page.keyboard.press('ArrowRight')
  const failures: string[] = []
  const luminance = (color: string) => {
    const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((value) => {
      const component = Number(value) / 255
      return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4
    })
    return r * 0.2126 + g * 0.7152 + b * 0.0722
  }
  for (const [theme, mode] of palettes) {
    await page.evaluate(({ theme, mode }) => {
      document.documentElement.dataset.docTheme = theme
      document.documentElement.dataset.theme = mode
    }, { theme, mode })
    const measured = await page.locator('.cm-content').evaluate((content) => {
      const editor = content.closest('.cm-editor')!
      const cursor = editor.querySelector('.cm-cursor')!
      const block = content.closest('.milkdown-code-block')!
      return { cursor: getComputedStyle(cursor).borderLeftColor,
        background: getComputedStyle(block).backgroundColor }
    })
    const cursor = luminance(measured.cursor)
    const background = luminance(measured.background)
    const ratio = (Math.max(cursor, background) + 0.05) / (Math.min(cursor, background) + 0.05)
    if (ratio < 3) failures.push(`${theme}/${mode}: cursor ${measured.cursor} on ${measured.background}, contrast ${ratio.toFixed(2)}`)
  }
  expect(failures).toEqual([])
  await page.evaluate(() => {
    document.documentElement.dataset.docTheme = 'drake'
    document.documentElement.dataset.theme = 'light'
  })
  await page.addStyleTag({ content: '.cm-cursorLayer { animation: none !important; opacity: 1 !important; }' })
  await page.locator('.cm-content').click()
  await page.keyboard.press('ArrowRight')
  const cursor = page.locator('.cm-cursor').first()
  await expect(cursor).toBeVisible()
  expect((await cursor.boundingBox())!.height).toBeGreaterThan(0)
  await page.locator('.milkdown-code-block').screenshot({ path: '/tmp/inkstone-drake-code-caret.png' })
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await expect(page.locator('.cm-content')).toHaveText('')
  await expect(cursor).toBeVisible()
  expect((await cursor.boundingBox())!.height).toBeGreaterThan(0)
  await expect.poll(async () => {
    const caret = (await cursor.boundingBox())!
    const scroller = (await page.locator('.cm-scroller').boundingBox())!
    return caret.x - scroller.x
  }).toBeGreaterThanOrEqual(0)
  await page.locator('.milkdown-code-block').screenshot({ path: '/tmp/inkstone-drake-empty-code-caret.png' })
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.cm-content')).toContainText('const message')
  await page.keyboard.press('ControlOrMeta+s')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.ink-tree-name').filter({ hasText: /^code-theme\.md$/ }).click()
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.cm-content')).toContainText('const message')
  await page.locator('.milkdown-code-block').screenshot({ path: '/tmp/inkstone-drake-code-caret-mobile.png' })
})
