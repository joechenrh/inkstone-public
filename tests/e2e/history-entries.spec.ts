import { expect, test, type Page } from '@playwright/test'

async function commitOnce(page: Page, text: string, message: string) {
  await page.locator('.ink-doc').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(600)
  await page.locator('[title="Commit"]').click()
  await page.locator('.ink-commit-message').fill(message)
  await page.keyboard.press('Enter')
  await expect(page.locator('.ink-commit')).toHaveCount(0, { timeout: 15_000 })
}

test('consecutive commits retain their messages and open their own changes', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^welcome\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toBeVisible({ timeout: 15_000 })

  await commitOnce(page, ' one', 'First revision')
  await commitOnce(page, ' two', 'Second revision')

  await page.keyboard.press('ControlOrMeta+/')
  await expect(page.locator('.ink-right')).toContainText('Second revision', { timeout: 15_000 })
  const items = page.locator('.ink-hist-item')
  const second = items.filter({ hasText: 'Second revision' })
  const first = items.filter({ hasText: 'First revision' })
  await second.locator('.ink-hist-entry').click()
  await expect(second.locator('.ink-hist-diff')).toContainText('two')
  await expect(first.locator('.ink-hist-diff')).toHaveCount(0)
  await first.locator('.ink-hist-entry').click()
  await expect(first.locator('.ink-hist-diff')).toContainText('one')
  await expect(second.locator('.ink-hist-diff')).toHaveCount(0)
  await expect(first.locator('.ink-hist-message')).toHaveText('First revision')
  await expect(second.locator('.ink-hist-message')).toHaveText('Second revision')
})
