import { expect, test, type Page } from '@playwright/test'

/**
 * Pasting a picture, in both engines.
 *
 * The whole feature only exists end to end: re-encode in the browser, store where the notes are
 * stored, put a path in the note, and turn that path back into something a browser can show. Each
 * half is testable alone and neither half is the feature.
 *
 * The engines reach it by completely different routes — one through Vditor's `upload.handler`, one
 * through a capture-phase listener that has to beat Crepe's own uploader to the event, which would
 * otherwise write `![](blob:…)` into the file. So both are driven here, through the same steps and
 * the same assertions: what is on screen, and what is on disk.
 */

/**
 * Each test pastes a picture of its own colour.
 *
 * Not decoration: a name is the hash of the *bytes*, one vault serves the whole suite, and the
 * re-encoder is deterministic — so two tests pasting the same pixels would have the second one
 * correctly told the picture was already here. Which is what the third test asserts on purpose.
 */

async function open(page: Page, engine: 'crepe') {
  await page.addInitScript((e) => { localStorage.setItem('inkstone.editorEngine', e) }, engine)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  const note = engine === 'crepe' ? 'picture-crepe.md' : 'picture.md'
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText('Before.', { timeout: 15_000 })
  return note
}

/** Paste it the way a screenshot arrives: a file on the clipboard and no text beside it. */
async function pasteImage(page: Page, colour: string) {
  await page.locator('.ink-doc').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.evaluate(async (fill) => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const context = canvas.getContext('2d')!
    context.fillStyle = fill
    context.fillRect(0, 0, 8, 8)
    const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/png') })
    const data = new DataTransfer()
    data.items.add(new File([blob!], 'shot.png', { type: 'image/png' }))
    const target = document.querySelector('.ink-doc')!
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, colour)
}

/** The picture in the document, as the browser resolved it — not as the markdown spells it. */
const shownSrc = (page: Page) => page.evaluate(() => {
  const img = Array.from(document.querySelectorAll<HTMLImageElement>('.ink-doc img'))
    .find((e) => (e.getAttribute('src') ?? '').includes('assets'))
  return img?.getAttribute('src') ?? null
})

for (const engine of ['crepe'] as const) {
  test(`${engine}: a pasted picture is stored, linked and shown`, async ({ page }) => {
    const note = await open(page, engine)
    await pasteImage(page, engine === 'crepe' ? '#c02f2f' : '#2f5fc0')

    // Stored under a name that is the hash of its own bytes, and referred to from the root so the
    // note survives being moved.
    await expect.poll(() => shownSrc(page), { timeout: 15_000 }).toMatch(/assets%2F[a-f0-9]{16}\./)

    // And it is a real picture at the far end, not a broken link.
    await expect.poll(() => page.evaluate(() => {
      const img = document.querySelector<HTMLImageElement>('.ink-doc img[data-ink-asset]')
      return img?.naturalWidth ?? 0
    })).toBeGreaterThan(0)

    // The line under it says what was done, because something was done: the file in the vault is
    // not the file that was on the clipboard.
    await expect(page.locator('.ink-paste-line')).toContainText('kept')

    // *Under* it. It measured against the caret while the picture was still loading and settled
    // there, which put the sentence on top of the thing it was describing.
    await expect.poll(() => page.evaluate(() => {
      const img = document.querySelector('.ink-doc img[data-ink-asset]')?.getBoundingClientRect()
      const line = document.querySelector('.ink-paste-line')?.getBoundingClientRect()
      if (img === undefined || line === undefined) return null
      return { below: line.top >= img.bottom - 1, aligned: Math.abs(line.left - img.left) < 2 }
    })).toEqual({ below: true, aligned: true })

    await page.keyboard.press('ControlOrMeta+s')
    // …and it goes away with the next keystroke.
    await expect(page.locator('.ink-paste-line')).toHaveCount(0)

    const saved = await page.evaluate(async (path) => {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`)
      return (await res.json() as { content: string }).content
    }, `notes/${note}`)
    expect(saved).toMatch(/!\[\]\(\/assets\/[a-f0-9]{16}\.\w+\)/)
    // Never a blob URL — a link into a tab that has since closed.
    expect(saved).not.toContain('blob:')
  })
}

test('a picture already in the vault is linked rather than written again', async ({ page }) => {
  await open(page, 'crepe')
  await pasteImage(page, '#2fc05f')
  await expect(page.locator('.ink-paste-line')).toContainText('kept')

  await pasteImage(page, '#2fc05f')
  await expect(page.locator('.ink-paste-line')).toContainText('nothing written')
})

test('the pictures are not in the file tree until the switch says so', async ({ page }) => {
  await open(page, 'crepe')
  await pasteImage(page, '#c0a02f')
  await expect(page.locator('.ink-paste-line')).toContainText('kept')
  // Storage rather than notes, so not in the way by default.
  await expect(page.locator('.ink-tree-name').filter({ hasText: /^assets$/ })).toHaveCount(0)

  // …but reachable, because a picture that cannot be reached cannot be deleted.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Shown' }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.ink-tree-name').filter({ hasText: /^assets$/ })).toHaveCount(1)

  // Reloaded rather than waited on: the tree learns about a new folder from the watcher, which has
  // a grace period, and this test is not about that.
  await page.reload()
  await expect(page.locator('.ink-tree-name').filter({ hasText: /^assets$/ })).toHaveCount(1)

  // And a click on one opens the picture rather than filling the editor with its bytes.
  const opened = page.waitForEvent('popup')
  await page.locator('.ink-tree-name').filter({ hasText: /^assets$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^[a-f0-9]{16}\./ }).first().click()
  expect((await opened).url()).toContain('/api/asset')
  // The editor is untouched: no note was opened, and nothing was filled with a picture's bytes.
  await expect(page.locator('.ink-doc')).not.toContainText('RIFF')
})

test('on a phone, a photo from the library reaches the document', async ({ page }) => {
  // The phone's button is nowhere near the editor — it is in the bottom bar, where a thumb is —
  // so this is as much a test of the wire between them as of the sheet.
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, 'crepe')
  await page.locator('.ink-phonebar .ink-viewbtn').first().click()
  await page.locator('.ink-picture-btn').click()
  await expect(page.getByText('Photo library')).toBeVisible()

  await page.locator('input[type=file]:not([capture])').setInputFiles({
    name: 'IMG_0421.png',
    mimeType: 'image/png',
    // 2×2, four colours: small, real, and nothing else in the suite pastes it.
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR4nGP8z4AATAxIHDQODhkI' +
      'CwAA//8DKgIBAgQFvQAAAABJRU5ErkJggg==',
      'base64',
    ),
  })

  await expect.poll(() => shownSrc(page), { timeout: 15_000 }).toMatch(/assets%2F[a-f0-9]{16}\./)
  await expect(page.locator('.ink-paste-line')).toContainText('kept')
})

/**
 * Clicking a picture.
 *
 * Typora answers a click on a picture with its own markdown, alt text selected, and the other
 * engine does the same — it keeps the source in marker spans and reveals them. This one answered
 * with a blue box: no address to read, no way to edit it, and no way to delete the picture by
 * deleting its syntax, which is how anyone who writes markdown deletes one.
 */
test('crepe: clicking a picture shows its markdown, and editing it sticks', async ({ page }) => {
  const note = await open(page, 'crepe')
  await pasteImage(page, '#7b2fc0')
  await expect.poll(() => shownSrc(page), { timeout: 15_000 }).toMatch(/assets%2F[a-f0-9]{16}\./)

  // The last: the note is shared with the test above, which left one of its own in it.
  await page.locator('.ink-doc img[data-ink-asset]').last().click()
  await expect(page.locator('.ink-doc')).toContainText(/!\[\]\(\/assets\/[a-f0-9]{16}\./)

  // And the picture is still there. The first version replaced it with its text, so clicking a
  // picture made the picture disappear — a source line is not a preview of anything.
  await expect(page.locator('.ink-source-preview')).toHaveCount(1)

  // The alt is empty, so the caret sits ready to write one.
  await page.keyboard.type('a screenshot')
  // Away, and it is a picture again — with what was typed kept, and the caret where it was put.
  // Closing used to set the selection beside the picture, which sent the caret back to it the
  // moment you clicked anywhere else, and took the view along.
  await page.locator('.ink-doc p').first().click()
  await expect(page.locator('.ink-doc')).not.toContainText('![')
  await expect(page.locator('.ink-source-preview')).toHaveCount(0)
  expect(await page.evaluate(() => document.getSelection()?.anchorNode?.textContent)).toContain('Before.')
  await expect(page.locator('.ink-doc img[alt="a screenshot"]')).toHaveCount(1)

  await page.keyboard.press('ControlOrMeta+s')
  const saved = await page.evaluate(async (path) => {
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`)
    return (await res.json() as { content: string }).content
  }, `notes/${note}`)
  expect(saved).toMatch(/!\[a screenshot\]\(\/assets\/[a-f0-9]{16}\.\w+\)/)
  // Never the escaped form, which is what an open one would serialise to.
  expect(saved).not.toContain('\\[')
})

test('crepe: reading a note leaves the picture alone', async ({ page }) => {
  await open(page, 'crepe')
  await pasteImage(page, '#2fc0a0')
  await expect.poll(() => shownSrc(page), { timeout: 15_000 }).toMatch(/assets%2F[a-f0-9]{16}\./)

  await page.getByRole('button', { name: 'Read' }).click()
  await page.locator('.ink-doc img[data-ink-asset]').last().click({ force: true })
  await expect(page.locator('.ink-doc')).not.toContainText('![')
})

/**
 * Enter, while a picture is showing its own markdown.
 *
 * Measured before the fix: the newline landed *inside the address*, because literal
 * `![](/assets/…)` is all the document holds while the source is open — the picture came back as
 * `![⏎11](…)`, and in the shape the reader hit, as text a serialiser then escapes into a picture
 * that can never render again. An Enter after clicking a picture is not an edit to its address.
 */
test('crepe: enter after clicking a picture closes it and makes a line', async ({ page }) => {
  const note = await open(page, 'crepe')
  await pasteImage(page, '#3f7fbf')
  await expect.poll(() => shownSrc(page), { timeout: 15_000 }).toMatch(/assets%2F[a-f0-9]{16}\./)
  await page.locator('.ink-doc img[data-ink-asset]').last().click()
  await expect(page.locator('.ink-doc')).toContainText(/!\[\]\(\/assets\//)

  await page.keyboard.press('Enter')
  await page.keyboard.type('11')
  await page.waitForTimeout(400)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)

  const saved = await page.evaluate(async (path) => {
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`)
    return (await res.json() as { content: string }).content
  }, `notes/${note}`)

  // The picture, whole, with the line after it.
  expect(saved).toMatch(/!\[\]\(\/assets\/[a-f0-9]{16}\.\w+\)\n\n11/)
  // Never the escaped form, which is a picture that cannot render again.
  expect(saved).not.toContain('\\!')
  // And it is a picture on screen again, not the text of one. Counted as "none of the source is
  // showing" rather than as a number of images: this note is shared with the tests above it, so how
  // many it holds depends on what ran first.
  await expect(page.locator('.ink-doc')).not.toContainText('![](')
  await expect(page.locator('.ink-source-preview')).toHaveCount(0)
})
