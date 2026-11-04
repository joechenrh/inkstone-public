import { expect, test, type Page } from '@playwright/test'

const temporary = 'notes/save-status.md'
const secondNote = 'notes/save-status-second.md'

test.afterEach(async ({ page }) => {
  await page.request.delete(`/api/file?path=${encodeURIComponent(temporary)}`)
  await page.request.delete(`/api/file?path=${encodeURIComponent(secondNote)}`)
})

async function open(page: Page, ownFile = false) {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter', exact: true }).click()
  if (ownFile) {
    await page.request.post('/api/file', { data: { path: temporary, kind: 'file' } })
    await page.request.put('/api/file', { data: { path: temporary, content: '# welcome\n' } })
    await page.reload()
  }
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: ownFile ? /^save-status\.md$/ : /^welcome\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('welcome')
}

test('Save all via shortcut leaves later typing unsaved without adding status controls', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let first = true
  await page.route('**/api/file', async (route) => {
    if (route.request().method() === 'PUT' && first) { first = false; await gate }
    await route.continue()
  })
  try {
    await open(page, true)
    await page.getByRole('button', { name: /Markdown source/ }).click()
    await page.locator('.ink-source-area').fill('# First draft\n')
    await page.keyboard.press('ControlOrMeta+Shift+s')
    await expect.poll(() => first).toBe(false)
    await expect(page.locator('.ink-document-save, .ink-save-all')).toHaveCount(0)
    await page.locator('.ink-source-area').fill('# Later typing\n')
    const settled = page.waitForResponse((response) => response.url().endsWith('/api/git/status'))
    release()
    await settled
    await page.evaluate(() => new Promise(requestAnimationFrame))
    await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(1)
    await page.keyboard.press('ControlOrMeta+Shift+s')
    await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
    const file = await page.request.get(`/api/file?path=${encodeURIComponent(temporary)}`)
    expect((await file.json()).content).toBe('# Later typing\n')
  } finally { release() }
})

test('a failed Save all retains the draft and can be retried', async ({ page }) => {
  let first = true
  await page.route('**/api/file', async (route) => {
    if (route.request().method() === 'PUT' && first) {
      first = false
      await route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } })
    } else await route.continue()
  })
  await open(page, true)
  await page.getByRole('button', { name: /Markdown source/ }).click()
  await page.locator('.ink-source-area').fill('# Keep this draft\n')
  await page.keyboard.press('ControlOrMeta+Shift+s')
  await expect(page.locator('.ink-conflict')).toContainText('Could not save')
  await expect(page.locator('.ink-source-area')).toHaveValue('# Keep this draft\n')
  await page.locator('.ink-git-error').getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('Save all restores draft metadata after reload and saves notes without switching them', async ({ page }) => {
  await open(page, true)
  await page.request.post('/api/file', { data: { path: secondNote, kind: 'file' } })
  await page.request.put('/api/file', { data: { path: secondNote, content: '# welcome second\n' } })
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^save-status\.md$/ }).click()
  await page.getByRole('button', { name: /Markdown source/ }).click()
  await page.locator('.ink-source-area').fill('# Draft one\n')
  await page.locator('.ink-tree-name').filter({ hasText: /^save-status-second\.md$/ }).click()
  await expect(page.locator('.ink-source-area')).toHaveValue('# welcome second\n')
  await page.locator('.ink-source-area').fill('# Draft two\n')
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^save-status-second\.md$/ }).click()
  await page.getByRole('button', { name: /Markdown source/ }).click()
  await expect(page.locator('.ink-source-area')).toHaveValue('# Draft two\n')
  await page.keyboard.press('ControlOrMeta+Shift+s')
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
  for (const [path, content] of [[temporary, '# Draft one\n'], [secondNote, '# Draft two\n']]) {
    const file = await page.request.get(`/api/file?path=${encodeURIComponent(path!)}`)
    expect((await file.json()).content).toBe(content)
  }
  await expect(page.locator('.ink-breadcrumb')).toHaveAttribute('title', secondNote)
  await expect(page.locator('.ink-document-save')).toHaveCount(0)
})

for (const phone of [false, true]) {
  test(`${phone ? 'phone' : 'desktop'}: changes loading failure is visible and retry opens the commit panel`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 })
    await page.route('**/api/git/status', (route) => route.fulfill({ json: { branch: 'main', dirty: true, hasRemote: false, ahead: 0 } }))
    let first = true
    await page.route('**/api/git/changes', (route) => {
      if (first) { first = false; return route.fulfill({ status: 503, json: { error: 'Cannot read changes' } }) }
      return route.fulfill({ json: { changes: [{ path: 'notes/welcome.md', status: 'modified', added: 1, removed: 0, diff: '@@ -0,0 +1 @@\n+draft' }] } })
    })
    await open(page)
    if (phone) {
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Commit…', exact: true }).click()
    } else await page.getByRole('button', { name: 'Commit', exact: true }).click()
    const notice = page.locator(phone ? '.ink-gitnotice' : '.ink-git-error')
    await expect(notice).toContainText('Cannot read changes')
    await notice.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Commit', exact: true })).toBeVisible()
  })

  test(`${phone ? 'phone' : 'desktop'}: push failure has a working retry`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 })
    let attempts = 0
    await page.route('**/api/git/status', (route) => route.fulfill({ json: { branch: 'main', dirty: false, hasRemote: true, ahead: attempts > 1 ? 0 : 2 } }))
    await page.route('**/api/git/push', (route) => ++attempts === 1
      ? route.fulfill({ status: 503, json: { error: 'Remote unavailable' } })
      : route.fulfill({ json: { pushed: 2 } }))
    await open(page)
    if (phone) {
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Push 2', exact: true }).click()
      await page.locator('.ink-gitnotice').getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(page.locator('.ink-gitnotice')).toContainText('Pushed 2')
    } else {
      await page.getByRole('button', { name: 'Push 2', exact: true }).click()
      await page.getByRole('button', { name: 'Retry push 2', exact: true }).click()
      await expect(page.locator('.ink-push-btn')).toHaveCount(0)
      await expect(page.locator('.ink-git-error')).toHaveCount(0)
    }
    expect(attempts).toBe(2)
  })
}
