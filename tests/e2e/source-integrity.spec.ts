import { expect, test, type Page } from '@playwright/test'

const file = 'notes/source-integrity.md'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
const cases = [
  { name: 'link title', source: '[reference](https://example.com/doc "Reference title")', image: false },
  { name: 'formatted link label', source: '[**bold** and *italic*](https://example.com/doc)', image: false,
    // Milkdown puts a strong mark outside the link. The label must keep both styles.
    saved: '**[bold](https://example.com/doc)** [and *italic*](https://example.com/doc)' },
  { name: 'escaped link label', source: '[a\\]b](https://example.com/doc)', image: false },
  { name: 'link destination with spaces', source: '[reference](<https://example.com/a b> "Reference title")', image: false },
  { name: 'image destination with parentheses', source: '![diagram](https://example.com/diagram_(small).png "Diagram title")', image: true },
  { name: 'escaped image alt text', source: '![diagram\\] note](https://example.com/diagram.png "Diagram title")', image: true },
]

async function tail(page: Page) {
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

test.beforeEach(async ({ page }) => {
  await page.route('https://example.com/**', (route) => route.fulfill({ contentType: 'image/png', body: png }))
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter', exact: true }).click()
  await page.request.post('/api/file', { data: { path: file, kind: 'file' } })
})

test.afterEach(async ({ page }) => { await page.request.delete(`/api/file?path=${encodeURIComponent(file)}`) })

for (const fixture of cases) {
  test(`visiting ${fixture.name} and editing elsewhere preserves its Markdown`, async ({ page }) => {
    const content = `${fixture.source}\n\nAfter.\n`
    await page.request.put('/api/file', { data: { path: file, content } })
    await page.reload()
    await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
    await page.locator('.ink-tree-name').filter({ hasText: /^source-integrity\.md$/ }).click()
    await expect(page.locator('.ink-doc')).toContainText('After.')
    await page.locator(fixture.image ? '.ink-doc img' : '.ink-doc a').first().click()
    await tail(page)
    await page.keyboard.type('x')
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(async () => (await (await page.request.get(`/api/file?path=${encodeURIComponent(file)}`)).json()).content)
      .toBe(`${fixture.saved ?? fixture.source}\n\nAfter.x\n`)
    await page.reload()
    await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
    await page.locator('.ink-tree-name').filter({ hasText: /^source-integrity\.md$/ }).click()
    if (fixture.image) await expect(page.locator('.ink-doc img').first()).toHaveAttribute('title', 'Diagram title')
    if (fixture.name === 'formatted link label') {
      await expect(page.locator('.ink-doc strong')).toHaveText('bold')
      await expect(page.locator('.ink-doc em')).toHaveText('italic')
    }
  })
}

test('HTML image paste does not invent a title from alt text', async ({ page }) => {
  await page.request.put('/api/file', { data: { path: file, content: 'After.\n' } })
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^source-integrity\.md$/ }).click()
  await tail(page)
  await page.keyboard.press('Enter')
  await page.locator('.ink-doc').evaluate((editor) => {
    const data = new DataTransfer()
    data.setData('text/html', '<img src="https://example.com/diagram.png" alt="Diagram alt">')
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.ink-doc img').first()).toBeVisible()
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await (await page.request.get(`/api/file?path=${encodeURIComponent(file)}`)).json()).content)
    .toBe('After.\n\n![Diagram alt](https://example.com/diagram.png)\n')
})

for (const image of [false, true]) {
  test(`editing an expanded ${image ? 'image' : 'link'} destination preserves its other attributes`, async ({ page }) => {
    const source = image
      ? '![diagram](https://example.com/old.png "Diagram title")'
      : '[**bold** and *italic*](https://example.com/old.png "Link title")'
    await page.request.put('/api/file', { data: { path: file, content: `${source}\n\nAfter.\n` } })
    await page.reload()
    await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
    await page.locator('.ink-tree-name').filter({ hasText: /^source-integrity\.md$/ }).click()
    await page.locator(image ? '.ink-doc img' : '.ink-doc a').first().click()
    await page.locator('.ink-doc p').first().evaluate((p) => {
      const nodes = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
        const at = node.textContent!.indexOf('https://example.com/old.png')
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 'https://example.com/old.png'.length)
        getSelection()!.removeAllRanges()
        getSelection()!.addRange(range)
        return
      }
      throw new Error('Expanded destination missing')
    })
    await page.keyboard.insertText('https://example.com/new_(small).png')
    await tail(page)
    await page.keyboard.type('x')
    await page.keyboard.press('ControlOrMeta+s')
    const expected = image
      ? '![diagram](https://example.com/new_(small).png "Diagram title")'
      : '**[bold](https://example.com/new_(small).png "Link title")** [and *italic*](https://example.com/new_(small).png "Link title")'
    await expect.poll(async () => (await (await page.request.get(`/api/file?path=${encodeURIComponent(file)}`)).json()).content)
      .toBe(`${expected}\n\nAfter.x\n`)
  })
}

for (const href of ['https://example.com/doc', 'https://example.com/a\\)b']) {
  test(`editing a revealed label retains mixed formatting and destination ${href}`, async ({ page }) => {
    const source = `[**bold** and *italic*](${href} "Link title")`
    await page.request.put('/api/file', { data: { path: file, content: `${source}\n\nAfter.\n` } })
    await page.reload()
    await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
    await page.locator('.ink-tree-name').filter({ hasText: /^source-integrity\.md$/ }).click()
    await page.locator('.ink-doc a').first().click()
    await page.locator('.ink-link-source-label').evaluate((label) => {
      const node = label.firstChild!
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, 4)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(range)
    })
    await page.keyboard.insertText('bolder')
    await tail(page)
    await page.keyboard.type('x')
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(async () => (await (await page.request.get(`/api/file?path=${encodeURIComponent(file)}`)).json()).content)
      .toBe(`**[bolder](${href} "Link title")** [and *italic*](${href} "Link title")\n\nAfter.x\n`)
  })
}
