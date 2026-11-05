import { expect, test, type Page } from '@playwright/test'

const first = 'notes/noop-legacy.md'
const second = 'notes/noop-second.md'
const original = '## **测试标题**\n\n- https://example.com/home:一个博客，有很多学习资料\n\n- https://example.net:说明文字\n\n需要配置规则: <https://raw.example.com/project/file.txt>\n\nAfter.\n'
const other = original.replace('测试标题', '另一个标题')

async function open(page: Page, path: string) {
  await page.locator('.ink-tree-name').filter({ hasText: path.split('/').pop()! }).click()
  await expect(page.locator('.ink-doc')).toContainText('After.')
}

async function endOfTail(page: Page) {
  await page.locator('.ink-doc p').filter({ hasText: /^After\./ }).evaluate((p) => {
    ;(p.closest('.ProseMirror') as HTMLElement).focus()
    const range = document.createRange()
    range.selectNodeContents(p)
    range.collapse(false)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  await page.waitForTimeout(100)
}

const read = async (page: Page, path: string) => (await (await page.request.get(`/api/file?path=${encodeURIComponent(path)}`)).json()).content as string

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter', exact: true }).click()
  for (const [path, content] of [[first, original], [second, other]]) {
    await page.request.post('/api/file', { data: { path, kind: 'file' } })
    await page.request.put('/api/file', { data: { path, content } })
  }
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
})

test.afterEach(async ({ page }) => {
  for (const path of [first, second]) await page.request.delete(`/api/file?path=${encodeURIComponent(path)}`)
})

test('opening, visiting marks and switching views never dirties or rewrites an old note', async ({ page }) => {
  let writes = 0
  await page.route('**/api/file', (route) => {
    if (route.request().method() === 'PUT') writes++
    return route.continue()
  })
  for (let turn = 0; turn < 3; turn++) {
    for (const path of [first, second]) {
      await open(page, path)
      await page.locator('.ink-doc h2 strong').click()
      await page.getByRole('button', { name: /^Read \(/ }).click()
      await page.getByRole('button', { name: /^Edit \(/ }).click()
      await page.waitForTimeout(450)
      await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
      await page.keyboard.press('ControlOrMeta+s')
      await page.keyboard.press('ControlOrMeta+Shift+s')
    }
  }
  expect(writes).toBe(0)
  expect(await read(page, first)).toBe(original)
  expect(await read(page, second)).toBe(other)
})

test('editing another line preserves bold headings, Unicode bare URLs and explicit angle autolinks', async ({ page }) => {
  await open(page, first)
  await page.locator('.ink-doc h2 strong').click()
  await endOfTail(page)
  await page.keyboard.type('x')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => read(page, first)).toBe(original.replace('After.', 'After.x'))
  await page.waitForTimeout(500)
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
})

test('switching notes immediately after typing keeps the draft with its original note', async ({ page }) => {
  await open(page, first)
  await endOfTail(page)
  await page.keyboard.type('x')
  await open(page, second)
  await page.waitForTimeout(500)
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
  await open(page, first)
  await expect(page.locator('.ink-doc')).toContainText('After.x')
  await page.keyboard.press('ControlOrMeta+Shift+s')
  await expect.poll(() => read(page, first)).toBe(original.replace('After.', 'After.x'))
  expect(await read(page, second)).toBe(other)
})

test('switching to Source after formatting flushes only real edits and keeps raw source authoritative', async ({ page }) => {
  await open(page, first)
  await page.locator('.ink-doc p').filter({ hasText: /^After\./ }).evaluate((p) => {
    ;(p.closest('.ProseMirror') as HTMLElement).focus()
    const range = document.createRange()
    range.selectNodeContents(p)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  await page.waitForTimeout(100)
  await page.keyboard.press('ControlOrMeta+b')
  await page.getByRole('button', { name: /Markdown source/ }).click()
  const formatted = original.replace('After.', '**After.**')
  await expect(page.locator('.ink-source-area')).toHaveValue(formatted)
  await page.locator('.ink-source-area').fill(`${formatted}\nRaw edit.\n`)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => read(page, first)).toBe(`${formatted}\nRaw edit.\n`)
  await page.waitForTimeout(500)
  await expect(page.locator('.ink-source-area')).toHaveValue(`${formatted}\nRaw edit.\n`)
})

test('notes with identical contents keep separate undo histories and save ownership', async ({ page }) => {
  const identical = original.replace('After.', 'After.x')
  await page.request.put('/api/file', { data: { path: second, content: identical } })
  await open(page, first)
  await endOfTail(page)
  await page.keyboard.type('x')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => read(page, first)).toBe(identical)
  await open(page, second)
  await endOfTail(page)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.ink-doc')).toContainText('After.x')
  await endOfTail(page)
  await page.keyboard.type('y')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => read(page, second)).toBe(identical.replace('After.x', 'After.xy'))
  expect(await read(page, first)).toBe(identical)
})

test('Source mode blocks edits during loading and separates native undo between notes', async ({ page }) => {
  await open(page, first)
  await page.getByRole('button', { name: /Markdown source/ }).click()
  await page.locator('.ink-source-area').fill(`${original}\nDraft belongs to first.\n`)
  let release!: () => void
  let started!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  const reading = new Promise<void>((resolve) => { started = resolve })
  await page.route((url) => url.pathname === '/api/file' && url.searchParams.get('path') === second, async (route) => {
    if (route.request().method() === 'GET') { started(); await hold }
    await route.continue()
  })
  await page.locator('.ink-tree-name').filter({ hasText: second.split('/').pop()! }).click()
  await reading
  await expect(page.locator('.ink-source-area')).toHaveAttribute('readonly', '')
  await page.locator('.ink-source-area').focus()
  await page.keyboard.type('wrong note')
  release()
  await expect(page.locator('.ink-source-area')).toHaveValue(other)
  await expect(page.locator('.ink-source-area')).not.toHaveAttribute('readonly', '')
  await page.locator('.ink-source-area').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.ink-source-area')).toHaveValue(other)
  await page.keyboard.press('ControlOrMeta+s')
  expect(await read(page, second)).toBe(other)
  await open(page, first)
  await expect(page.locator('.ink-source-area')).toHaveValue(`${original}\nDraft belongs to first.\n`)
})
