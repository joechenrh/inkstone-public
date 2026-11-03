import { expect, test, type Page } from '@playwright/test'

/**
 * A URL is written as a URL.
 *
 * Reported as "链接复制不要直接转成 `[1](2)` 这样" — a copied URL arriving as link syntax. What the
 * measurement found was worse than the paste: a note that already held a bare URL was rewritten on
 * save, `https://example.com/a` becoming `<https://example.com/a>`, so merely opening a note put
 * angle brackets round every URL in it. Same class as the backslashes in `escapes.spec.ts`.
 *
 * The round trip is asserted byte for byte, because that is the property: a vault in git must not
 * show a diff on a line nobody edited. The boundary is pinned too — a URL that cannot survive the
 * bare form keeps its brackets, and a link with words for its text is still a link.
 */

const FILE = 'notes/bare-url.md'

async function open(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^bare-url\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('After.', { timeout: 15_000 })
}

const read = (page: Page) => page.evaluate(async (at) => {
  const res = await fetch(`/api/file?path=${encodeURIComponent(at)}`)
  return (await res.json() as { content: string }).content
}, FILE)

/** Dirty without changing, so what is saved is the serialiser's opinion of the note. */
async function touchAndSave(page: Page) {
  await page.locator('.ink-doc p').filter({ hasText: 'After.' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('z')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(600)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(1200)
}

test('opening a note and saving it leaves every url as it was', async ({ page }) => {
  await open(page)
  const before = await read(page)
  await touchAndSave(page)

  // Byte for byte. One differing line is angle brackets in somebody's note.
  expect(await read(page)).toBe(before)
})

test('a bare url is still a link in the document', async ({ page }) => {
  await open(page)
  // Writing it plainly to the file is not the same as treating it as text: in the note it is
  // clickable, which is what it is for.
  const href = await page.locator('.ink-doc a').filter({ hasText: 'example.com/a/b' }).first()
    .getAttribute('href')
  expect(href).toBe('https://example.com/a/b?c=1')
})

test('a url pasted at the caret reaches the file without brackets', async ({ page }) => {
  await open(page)
  const tail = page.locator('.ink-doc p').filter({ hasText: 'After.' }).first()
  await tail.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('pasted: ')
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text/plain', 'https://example.com/pasted/here')
    document.querySelector('.ProseMirror')!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  })
  await page.waitForTimeout(400)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(1200)

  const saved = await read(page)
  expect(saved, 'the pasted url was wrapped in angle brackets').toContain('pasted: https://example.com/pasted/here')
  expect(saved).not.toContain('<https://example.com/pasted/here>')
})

for (const html of [false, true]) {
  test(`a pasted url stays bare when the caret enters it (${html ? 'HTML link' : 'plain text'})`, async ({ page }) => {
    await open(page)
    await page.locator('.ink-doc p').filter({ hasText: 'After.' }).first().evaluate((p) => {
      const range = document.createRange()
      range.selectNodeContents(p)
      range.collapse(false)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      ;(p.closest('.ProseMirror') as HTMLElement).focus()
    })
    await page.keyboard.press('Enter')
    const url = 'https://notes.example.com/'
    await page.evaluate(({ url, html }) => {
      const data = new DataTransfer()
      data.setData('text/plain', url)
      if (html) data.setData('text/html', `<a href="${url}">${url}</a>`)
      document.querySelector('.ProseMirror')!.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    }, { url, html })
    // The old test only saved. The duplication appears when the caret moves back into the link.
    await page.keyboard.press('ArrowLeft')
    const paragraph = page.locator('.ink-doc p').filter({ hasText: url }).last()
    await expect(paragraph).toHaveText(url)
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => read(page)).toContain(`\n${url}\n`)
    await expect(paragraph).toHaveText(url)
  })
}

test('entering a bare url leaves it bare while a named link still reveals its syntax', async ({ page }) => {
  await open(page)
  const bare = page.locator('.ink-doc p').filter({ hasText: /^https:\/\/example\.com\/a\/b\?c=1$/ })
  await bare.locator('a').click()
  await page.keyboard.press('ArrowLeft')
  await expect(bare).toHaveText('https://example.com/a/b?c=1')
  const punctuation = page.locator('.ink-doc p').filter({ hasText: /^https:\/\/example\.com\/~user$/ })
  await punctuation.locator('a').click()
  await expect(punctuation).toHaveText('https://example.com/~user')
  const named = page.locator('.ink-doc p').filter({ hasText: 'A paragraph with' })
  await named.locator('a').click()
  await expect(named).toContainText('[a link](https://example.com/docs)')
})

/**
 * Where the brackets stay.
 *
 * Not every URL survives being written as text: `~` is one of the characters the serialiser's
 * backslash is taken off, so the bare form could come back as something else. For those the
 * bracketed spelling is the correct one, and this pins that boundary so a later widening of the
 * rule has to be deliberate.
 */
test('a url that cannot survive the bare form keeps its brackets', async ({ page }) => {
  await open(page)
  await touchAndSave(page)
  const saved = await read(page)
  expect(saved, 'the tilde url lost brackets it needs').toContain('<https://example.com/~user>')
  // And a link with words for its text is untouched: it is a link, not a URL.
  expect(saved).toContain('[a link](https://example.com/docs)')
})
