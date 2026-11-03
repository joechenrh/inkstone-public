import { expect, test, type Page } from '@playwright/test'

/**
 * The picture, while it is still going up.
 *
 * Asked for as Typora's behaviour: 先有一个模糊的图片展示，然后图片中间有个 uploading. Until now the
 * document showed nothing at all between the paste and the host's answer.
 *
 * The upload is held open by the test rather than hoped to be slow — on a local server it is a few
 * milliseconds, and a test that waits for a race is a test that fails on somebody else's machine.
 * What is asserted while it is held is both halves: the reader sees the picture, and the *file*
 * does not. A placeholder that could be saved would be the `blob:` address bug all over again.
 */

const NOTE = 'uploading-crepe.md'

async function open(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${NOTE.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText('Before.', { timeout: 15_000 })
}

/** A small picture on the clipboard, pasted at the end of the note. */
async function paste(page: Page) {
  await page.locator('.ink-doc').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 200
    const context = canvas.getContext('2d')!
    context.fillStyle = '#c0392b'
    context.fillRect(0, 0, 320, 200)
    context.fillStyle = '#f1c40f'
    context.fillRect(20, 20, 120, 60)
    const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/png') })
    const data = new DataTransfer()
    data.items.add(new File([blob!], 'shot.png', { type: 'image/png' }))
    document.querySelector('.ink-doc')!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  })
}

const read = (page: Page) => page.evaluate(async (at) => {
  const res = await fetch(`/api/file?path=${encodeURIComponent(at)}`)
  return (await res.json() as { content: string }).content
}, `notes/${NOTE}`)

test('the picture is on the page before the upload finishes, and not in the file', async ({ page }) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route(/\/api\/(asset|upload)$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await held
    return route.continue()
  })

  await open(page)
  const before = await read(page)
  await paste(page)

  const placeholder = page.locator('.ink-uploading')
  await expect(placeholder).toBeVisible({ timeout: 10_000 })
  await expect(placeholder.locator('.ink-uploading-label')).toHaveText('Uploading…')
  // The local bytes, which is the whole point: the reader sees *their* picture, not a spinner.
  expect(await placeholder.locator('img').getAttribute('src')).toMatch(/^blob:/)
  // Dimmed rather than drawn as finished.
  const look = await placeholder.locator('img').evaluate((el) => {
    const cs = getComputedStyle(el)
    return { filter: cs.filter, opacity: parseFloat(cs.opacity) }
  })
  expect(look.filter).toContain('blur')
  expect(look.opacity).toBeLessThan(1)

  // Saved mid-upload: a decoration is drawn and never serialised, so the file is untouched.
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(1500)
  const during = await read(page)
  expect(during, 'the placeholder reached the file').not.toContain('blob:')
  expect(during).toBe(before)

  release()
  // And when it lands, the placeholder goes and a real picture is there in its place.
  await expect(placeholder).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('.ink-doc img[src*="assets"]')).toHaveCount(1, { timeout: 15_000 })
})

test('a refused upload does not leave a picture waiting for ever', async ({ page }) => {
  await page.route(/\/api\/(asset|upload)$/, (route) => (
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, body: 'no' })
      : route.continue()
  ))

  await open(page)
  await paste(page)

  // It may never be seen at all — the failure is immediate here — but it must not be left behind.
  await expect(page.locator('.ink-uploading')).toHaveCount(0, { timeout: 15_000 })
})
