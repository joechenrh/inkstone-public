import { expect, test, type Page } from '@playwright/test'

const newest = 'a'.repeat(40)
const oldest = 'b'.repeat(40)
const patch = (label: string) => `@@ -1 +1 @@\n-before ${label}\n+after ${label}\n`

async function openHistory(page: Page) {
  await page.route('**/api/git/log?*', (route) => route.fulfill({ json: { commits: [
    { sha: newest, date: new Date().toISOString(), message: 'Recent edit', added: 1, removed: 1 },
    { sha: oldest, date: new Date(Date.now() - 86400000).toISOString(), message: 'Original note', added: 1, removed: 0 },
  ] } }))
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter', exact: true }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('Heading level 1')
  await page.getByRole('button', { name: /Toggle right panel/ }).click()
  await expect(page.locator('.ink-hist-entry')).toHaveCount(2)
}

test('loading a diff keeps the history row at full opacity and the same size', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/git/diff?*', async (route) => {
    await gate
    await route.fulfill({ json: { diff: patch('stable') } })
  })
  try {
    await openHistory(page)
    const row = page.locator('.ink-hist-entry').first()
    await row.hover()
    const before = await row.boundingBox()
    await row.click()
    await expect(row).toHaveAttribute('aria-busy', 'true')
    await expect(row).toHaveCSS('opacity', '1')
    expect(await row.boundingBox()).toEqual(before)
    release()
    await expect(row).toHaveAttribute('aria-expanded', 'true')
    await expect(row).toHaveCSS('opacity', '1')
  } finally { release() }
})

test('a failed diff reports an error and can be retried', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/git/diff?*', (route) => ++attempts === 1
    ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    : route.fulfill({ json: { diff: patch('retry') } }))
  await openHistory(page)
  await page.locator('.ink-hist-entry').first().click()
  await expect(page.getByRole('alert')).toContainText('Could not load changes.')
  await expect(page.locator('.ink-hist-diff')).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.locator('.ink-hist-diff')).toContainText('-before retry')
  await expect(page.locator('.ink-hist-diff')).toContainText('+after retry')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a slow earlier diff cannot replace the later selection', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let waiting = false
  await page.route('**/api/git/diff?*', async (route) => {
    const slow = new URL(route.request().url()).searchParams.get('to') === newest
    if (slow) { waiting = true; await gate }
    await route.fulfill({ json: { diff: patch(slow ? 'slow' : 'chosen') } })
  })
  try {
    await openHistory(page)
    await page.locator('.ink-hist-entry').first().click()
    await expect.poll(() => waiting).toBe(true)
    await page.locator('.ink-hist-entry').nth(1).click()
    await expect(page.locator('.ink-hist-diff')).toContainText('after chosen')
    const arrived = page.waitForResponse((response) => response.url().includes(`to=${newest}`))
    release()
    await arrived
    await page.evaluate(() => new Promise(requestAnimationFrame))
    await expect(page.locator('.ink-hist-diff')).toContainText('after chosen')
    await expect(page.locator('.ink-hist-entry').nth(1)).toHaveAttribute('aria-expanded', 'true')
  } finally { release() }
})

for (const action of ['switch note', 'edit draft'] as const) {
  test(`a pending restore preserves the current content after ${action}`, async ({ page }) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let waiting = false
    await page.route('**/api/git/diff?*', (route) => route.fulfill({ json: { diff: patch('version') } }))
    await page.route('**/api/git/file-at?*', async (route) => {
      waiting = true
      await gate
      await route.fulfill({ json: { content: '# Old version that must not replace the draft\n' } })
    })
    try {
      await openHistory(page)
      if (action === 'edit draft') await page.getByRole('button', { name: /Markdown source/ }).click()
      await page.locator('.ink-hist-entry').first().click()
      await page.getByRole('button', { name: 'Restore this version' }).click()
      await expect.poll(() => waiting).toBe(true)
      if (action === 'switch note') {
        await page.locator('.ink-tree-name').filter({ hasText: /^hello\.md$/ }).click()
        await expect(page.locator('.ink-doc')).toContainText('hello')
      } else {
        await page.locator('.ink-source-area').fill('# Keep this draft\n')
      }
      const arrived = page.waitForResponse((response) => response.url().includes('/api/git/file-at?'))
      release()
      await arrived
      await page.evaluate(() => new Promise(requestAnimationFrame))
      if (action === 'switch note') {
        await expect(page.locator('.ink-doc')).not.toContainText('Old version')
        await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
      } else {
        await expect(page.locator('.ink-source-area')).toHaveValue('# Keep this draft\n')
        await expect(page.locator('.ink-hist')).toContainText('The note changed while loading this version.')
      }
    } finally { release() }
  })
}
