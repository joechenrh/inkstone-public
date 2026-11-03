import { chromium, webkit, expect, test as base, type Locator, type Page } from '@playwright/test'

const test = base.extend({
  page: async ({}, use, info) => {
    const engine = info.titlePath.includes('webkit') ? webkit : chromium
    const browser = await engine.launch()
    try {
      const context = await browser.newContext({ baseURL: 'http://127.0.0.1:7699', viewport: { width: 1000, height: 850 } })
      await use(await context.newPage())
    } finally { await browser.close() }
  },
})

async function open(page: Page, name = 'expanded-links.md') {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: name }).click()
  await expect(page.locator('.ink-doc')).toContainText('After.')
  await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true')
}

async function selectParagraph(page: Page, paragraph: Locator) {
  await paragraph.evaluate((p) => {
    ;(p.closest('.ProseMirror') as HTMLElement).focus()
    const range = document.createRange()
    range.selectNodeContents(p)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function copyParagraph(page: Page, paragraph: Locator): Promise<{ text: string; html: string }> {
  await selectParagraph(page, paragraph)
  await page.evaluate(() => {
    const next = new Promise<{ text: string; html: string }>((resolve) => {
      document.addEventListener('copy', (event) => resolve({
        text: event.clipboardData!.getData('text/plain'), html: event.clipboardData!.getData('text/html'),
      }), { once: true })
    })
    ;(window as unknown as { copiedParagraph: typeof next }).copiedParagraph = next
  })
  await page.keyboard.press('ControlOrMeta+c')
  return page.evaluate(() => (window as unknown as { copiedParagraph: Promise<{ text: string; html: string }> }).copiedParagraph)
}

async function pastePayload(page: Page, payload: { text: string; html?: string }) {
  await page.evaluate((given) => {
    const data = new DataTransfer()
    data.setData('text/plain', given.text)
    if (given.html) data.setData('text/html', given.html)
    document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true,
    }))
  }, payload)
}

async function pointOnText(locator: Locator) {
  return locator.evaluate((span) => {
    const range = document.createRange()
    range.selectNodeContents(span)
    const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 && r.height > 0)!
    return { x: rect.left + Math.min(8, rect.width / 2), y: rect.top + rect.height / 2 }
  })
}

for (const browserName of ['chromium', 'webkit'] as const) {
  test.describe(browserName, () => {
    for (const format of ['html', 'text']) {
      test(`replacing copied links repeatedly does not nest or escape their targets (${format})`, async ({ page }) => {
        const name = `repeated-links-${browserName}-${format}.md`
        await open(page, name)
        const url = 'https://notes.example.com/'
        const markdown = `[11111://notes.example.com/](${url})`
        const original = `Before.\n\n${markdown}\n\nAfter.\n`
        const paragraph = page.locator('.ink-doc p').filter({ hasText: '11111://' })
        const read = () => page.evaluate(async (path) => (await (await fetch(`/api/file?path=${encodeURIComponent(path)}`)).json()).content as string, `notes/${name}`)
        for (let round = 0; round < 5; round++) {
          if (round % 2 === 1) {
            await paragraph.locator('a').click()
            await expect(page.locator('.ink-link-source-label')).toHaveText('11111://notes.example.com/')
          }
          const payload = await copyParagraph(page, paragraph)
          expect(payload.text).toBe(markdown)
          await pastePayload(page, format === 'html' ? payload : { text: payload.text })
          await page.keyboard.press('ControlOrMeta+s')
          await expect.poll(read).toBe(original)
          await page.reload()
          await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
          await page.locator('.ink-tree-name').filter({ hasText: name }).click()
          await expect(paragraph.locator('a')).toHaveAttribute('href', url)
        }

        // Inside revealed Markdown, pasting into the destination edits that field as text.
        await paragraph.locator('a').click()
        const destination = page.locator('.ink-link-source-target')
        await expect(destination).toHaveText(url)
        await selectParagraph(page, destination)
        await pastePayload(page, { text: 'https://example.com/inside' })
        await expect(destination).toHaveText('https://example.com/inside')
        await page.keyboard.press('ControlOrMeta+s')
        await expect.poll(read).toBe('Before.\n\n[11111://notes.example.com/](https://example.com/inside)\n\nAfter.\n')

        // The reported input starts with a URL but also contains Markdown. It must not be
        // attached as one href to the selected old link, even when the clipboard has no HTML.
        await selectParagraph(page, paragraph)
        await pastePayload(page, {
          text: `${url}${markdown}`,
          ...(format === 'html' ? { html: `${url}<a href="${url}">11111://notes.example.com/</a>` } : {}),
        })
        await page.keyboard.press('ControlOrMeta+s')
        const links = await paragraph.locator('a').evaluateAll((nodes) => nodes.map((a) => a.getAttribute('href')!))
        expect(links.length).toBeGreaterThan(0)
        for (const href of links) {
          expect(href).not.toContain('](')
          expect(href).not.toContain('\\')
        }

        // Pasting an actual URL over an existing link replaces its label too, rather than
        // making the old label (or revealed Markdown) point at a new address.
        await selectParagraph(page, paragraph)
        await pastePayload(page, { text: 'https://example.com/replacement' })
        await expect(page.locator('.ink-doc a[href="https://example.com/replacement"]')).toHaveText('https://example.com/replacement')
        await page.keyboard.press('ControlOrMeta+s')
        await expect.poll(read).toBe('Before.\n\nhttps://example.com/replacement\n\nAfter.\n')

        // Plain selected prose still supports assigning a URL without replacing its label.
        await selectParagraph(page, page.locator('.ink-doc p').filter({ hasText: /^Before\.$/ }))
        await pastePayload(page, { text: 'https://example.com/attach' })
        await expect(page.locator('.ink-doc a[href="https://example.com/attach"]')).toHaveText('Before.')
        await page.keyboard.press('ControlOrMeta+s')
        await expect.poll(read).toContain('[Before.](https://example.com/attach)')
      })
    }

    test('Command-click opens expanded labels and destinations, including URLs with parentheses', async ({ page }) => {
      await page.context().route('https://example.com/**', (route) => route.fulfill({ body: 'Destination' }))
      await open(page)
      const urls = ['https://example.com/docs', 'https://example.com/same',
        'https://example.com/wiki/Foo_(bar)', `https://example.com/${'part/'.repeat(18)}`]
      for (const url of urls) {
        for (const part of ['label', 'target']) {
          await page.locator(`.ink-doc a[href="${url}"]`).click()
          const source = page.locator(`.ink-link-source-${part}`)
          await expect(source).toBeVisible()
          const point = await pointOnText(source)
          await page.keyboard.down('Meta')
          const [popup] = await Promise.all([
            page.waitForEvent('popup'),
            page.mouse.click(point.x, point.y),
          ])
          await page.keyboard.up('Meta')
          await popup.waitForLoadState()
          expect(popup.url()).toBe(url)
          await popup.close()
          await page.bringToFront()
          // Closing the raw syntax again must restore exactly the same destination.
          await page.locator('.ink-doc p').filter({ hasText: /^After\.$/ }).click()
          await expect(page.locator(`.ink-doc a[href="${url}"]`)).toBeVisible()
        }
      }
    })

    test('expanded syntax keeps link styling and leaves blank space inert', async ({ page }) => {
      await open(page)
      const link = page.locator('.ink-doc a[href="https://example.com/docs"]')
      const colour = await link.evaluate((a) => getComputedStyle(a).color)
      await link.click()
      const label = page.locator('.ink-link-source-label')
      const target = page.locator('.ink-link-source-target')
      await expect(label).toHaveCSS('color', colour)
      await expect(label).toHaveCSS('text-decoration-line', 'underline')
      await expect(target).toHaveText('https://example.com/docs')
      const markerColour = await page.locator('.ink-link-source-marker').first().evaluate((s) => getComputedStyle(s).color)
      expect(markerColour).not.toBe(colour)
      await page.screenshot({ path: test.info().outputPath('expanded-link.png'), caret: 'initial' })
      await page.evaluate(() => { window.open = () => { document.documentElement.dataset.opened = 'yes'; return null } })
      const box = (await target.boundingBox())!
      await page.keyboard.down('Meta')
      await page.mouse.click(box.x + box.width + 100, box.y + box.height / 2)
      await page.keyboard.up('Meta')
      expect(await page.locator('html').getAttribute('data-opened')).toBeNull()
    })

    test('copying explicit links keeps Markdown in plain text and a link in HTML', async ({ page }) => {
      await open(page)
      for (const mode of ['Read', 'Edit', 'Expanded', 'Bare']) {
        if (mode === 'Read' || mode === 'Edit') {
          await page.getByRole('button', { name: new RegExp(`^${mode} \\(`) }).click()
          await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', mode === 'Edit' ? 'true' : 'false')
        } else if (mode === 'Expanded') {
          await page.locator('.ink-doc a[href="2"]').evaluate((a) => {
            ;(a.closest('.ProseMirror') as HTMLElement).focus()
            const range = document.createRange()
            range.selectNodeContents(a)
            range.collapse(false)
            window.getSelection()!.removeAllRanges()
            window.getSelection()!.addRange(range)
          })
          await expect(page.locator('.ink-link-source-label')).toHaveText('1')
        } else {
          await page.locator('.ink-doc a[href="https://notes.example.com/"]').click()
        }
        const shown = mode === 'Expanded' ? /^\[1\]\(2\)$/
          : mode === 'Bare' ? /^https:\/\/notes\.example\.com\/$/ : /^1$/
        await page.locator('.ink-doc p').filter({ hasText: shown }).evaluate((p) => {
          const range = document.createRange()
          range.selectNodeContents(p)
          const selection = window.getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          const next = new Promise<{ text: string; html: string }>((resolve) => {
            document.addEventListener('copy', (event) => resolve({
              text: event.clipboardData!.getData('text/plain'), html: event.clipboardData!.getData('text/html'),
            }), { once: true })
          })
          ;(window as unknown as { copiedLink: typeof next }).copiedLink = next
        })
        // Selection must reach the editor before its copy handler runs.
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        await page.keyboard.press('ControlOrMeta+c')
        const payload = await page.evaluate(() => (window as unknown as {
          copiedLink: Promise<{ text: string; html: string }>
        }).copiedLink)
        expect(payload.text, mode).toBe(mode === 'Bare' ? 'https://notes.example.com/' : '[1](2)')
        expect(payload.html, mode).toContain(mode === 'Bare' ? 'href="https://notes.example.com/"' : 'href="2"')
        expect(payload.html, mode).not.toContain('[1](2)')
      }
    })
  })
}
