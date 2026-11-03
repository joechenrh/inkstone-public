import { expect, test } from '@playwright/test'

test('literal URL backslashes do not grow after saving and reopening repeatedly', async ({ page }) => {
  const request = page.request
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await expect(page.locator('.ink-tree-name').first()).toBeVisible()
  const path = 'notes/autolink-roundtrip.md'
  const url = '<https://www.example.com/book>\n\n<https://www' + '\\'.repeat(4) + '.example.com/book>'
  await request.post('/api/file', { data: { path, kind: 'file' } })
  await request.put('/api/file', { data: { path, content: `${url}\n\nAfter.\n` } })
  try {
  let suffix = ''
  for (let round = 0; round < 5; round++) {
    await page.reload()
    await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
    await page.locator('.ink-tree-name').filter({ hasText: /^autolink-roundtrip\.md$/ }).click()
    const tail = page.locator('.ink-doc p').filter({ hasText: /^After\./ })
    await expect(tail).toBeVisible()
    await tail.evaluate((p) => {
      ;(p.closest('.ProseMirror') as HTMLElement).focus()
      const range = document.createRange()
      range.selectNodeContents(p)
      range.collapse(false)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(range)
    })
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    suffix += String(round)
    await page.keyboard.type(String(round))
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(async () => (await (await request.get(`/api/file?path=${encodeURIComponent(path)}`)).json()).content)
      .toBe(`${url}\n\nAfter.${suffix}\n`)
  }
  } finally {
    await request.delete('/api/file', { data: { path } })
  }
})
