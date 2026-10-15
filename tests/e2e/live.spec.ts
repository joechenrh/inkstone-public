import { expect, test, type Page } from '@playwright/test'

/**
 * Two browsers, one note.
 *
 * Everything else about live collaboration can be tested without a network — the registry's clocks
 * (`live-store.test.ts`), the wire from both ends (`live-protocol.test.ts`, `live-provider.test.ts`)
 * — but not this: that the owner's editor, the server, and a stranger's editor agree about one
 * document, and that the result is in the file afterwards.
 *
 * The two pages are separate browser *contexts*, not tabs: a guest has no session cookie and must
 * not be able to borrow the owner's. If this test ever passes with a shared context and fails with
 * separate ones, the guest page is reading a credential it should not have.
 */

async function signIn(page: Page, note: string, expectText: string) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText(expectText, { timeout: 15_000 })
}

/**
 * The caret immediately after `text`, set through the DOM.
 *
 * Clicking a paragraph and pressing End does not reliably land where it reads as if it would —
 * `Mod-End` is not document-end in this editor either — and a caret one place out writes the test's
 * own text into the wrong paragraph. The marker tests learned this the same way.
 */
async function caretAfter(page: Page, text: string) {
  await page.evaluate((needle) => {
    const walk = document.createTreeWalker(document.querySelector('.ink-doc')!, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walk.nextNode()) !== null) {
      const at = (node.textContent ?? '').indexOf(needle)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at + needle.length)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    throw new Error(`${needle} is not on screen`)
  }, text)
  await page.waitForTimeout(250)
}

/** The owner's menu, from the tree row: the only entry point a desktop needs. */
async function startSession(page: Page, note: string): Promise<string> {
  const row = page.locator('.ink-tree-row').filter({ hasText: note })
  await row.hover()
  await page.getByRole('button', { name: `Actions for ${note}` }).click()
  await page.getByText('Live share…').click()
  await page.getByRole('button', { name: '开始协作' }).click()
  const link = page.locator('#ink-live-link')
  await expect(link).toBeVisible({ timeout: 15_000 })
  const url = await link.inputValue()
  expect(url).toMatch(/\/live\/[abcdefghjkmnpqrstuvwxyz23456789]{6}$/)
  return url
}

/** Out of the panel and back to the note. The panel is modal: it covers the document. */
async function closePanel(page: Page) {
  await page.getByRole('button', { name: '关闭' }).click()
  await expect(page.locator('.ink-live-card')).toHaveCount(0)
}

/** Back into it, from the note's own menu — which is where a running session is reached. */
async function reopenPanel(page: Page, note: string) {
  const row = page.locator('.ink-tree-row').filter({ hasText: note })
  await row.hover()
  await page.getByRole('button', { name: `Actions for ${note}` }).click()
  await page.getByText('协作中').click()
  await expect(page.locator('.ink-live-card')).toContainText('协作中')
}

// Two editors, two contexts and a document going round twice: the default budget is for one page.
test.setTimeout(120_000)

test('crepe: a guest with the link edits the note, and the owner keeps the result', async ({ browser }) => {
  const owner = await browser.newContext()
  const guest = await browser.newContext()
  const mine = await owner.newPage()
  const theirs = await guest.newPage()

  try {
    await signIn(mine, 'live-crepe.md', 'Before.')
    const url = await startSession(mine, 'live-crepe.md')
    await closePanel(mine)

    // A stranger: no cookie, no account, no name yet.
    await theirs.goto(url)
    await expect(theirs.locator('.ink-live-card')).toContainText('加入协作')
    await theirs.locator('#ink-live-name').fill('小林')
    await theirs.getByRole('button', { name: '加入' }).click()

    // The note arrives from the room rather than from a file: this browser cannot read the vault.
    await expect(theirs.locator('.ink-doc')).toContainText('Before.', { timeout: 15_000 })

    // The guest types, and it reaches the owner's screen.
    await caretAfter(theirs, 'Before.')
    await theirs.keyboard.type(' 小林来过。')
    await expect(mine.locator('.ink-doc')).toContainText('小林来过。', { timeout: 15_000 })

    // And the other way.
    await caretAfter(mine, 'After.')
    await mine.keyboard.type(' 我也在。')
    await expect(theirs.locator('.ink-doc')).toContainText('我也在。', { timeout: 15_000 })

    // The guest is in the owner's presence list, by the name they chose.
    await reopenPanel(mine, 'live-crepe.md')
    await expect(mine.locator('.ink-live-who')).toContainText('小林')

    // Ending saves what the two of them wrote, and tells the guest so.
    await mine.getByRole('button', { name: '结束协作' }).click()
    await expect(mine.locator('.ink-live-card')).toContainText('协作已结束', { timeout: 15_000 })
    await expect(theirs.locator('.ink-live-banner-over')).toContainText('协作已结束', { timeout: 15_000 })

    const saved = await mine.evaluate(async () => {
      const res = await fetch(`/api/file?path=${encodeURIComponent('notes/live-crepe.md')}`)
      return (await res.json() as { content: string }).content
    })
    expect(saved, 'the session was not saved').toContain('小林来过。')
    expect(saved).toContain('我也在。')
  } finally {
    await owner.close()
    await guest.close()
  }
})

test('a link that is not a session says so, in one sentence for every reason', async ({ page }) => {
  await page.goto('/live/zzzzzz')
  await expect(page.locator('.ink-live-blank')).toContainText('这个链接用不了')
  // And nothing about which note, which account, or whether it ever existed.
  await expect(page.locator('.ink-live-blank')).not.toContainText('notes/')
})

test('the syntax does not reveal itself during a session: the markers would travel', async ({ browser }) => {
  const owner = await browser.newContext()
  const mine = await owner.newPage()
  try {
    await signIn(mine, 'live-marks-crepe.md', 'Before.')
    await caretAfter(mine, 'Before.')
    await mine.keyboard.type(' **加粗**')
    await mine.waitForTimeout(400)
    // Outside a session the caret in a bold run shows its asterisks. That is the feature.
    await mine.locator('.ink-doc strong').first().click()
    await mine.waitForTimeout(400)
    await expect(mine.locator('.ink-doc')).toContainText('**加粗**')

    const url = await startSession(mine, 'live-marks-crepe.md')
    expect(url).toContain('/live/')
    await closePanel(mine)
    await mine.waitForTimeout(600)

    // Inside one it does not: those asterisks are real characters in a shared document, and every
    // caret that opened a run would put them on everybody else's screen.
    await mine.locator('.ink-doc strong').first().click()
    await mine.waitForTimeout(600)
    await expect(mine.locator('.ink-doc')).not.toContainText('**加粗**')
    await expect(mine.locator('.ink-doc strong')).toContainText('加粗')

    await reopenPanel(mine, 'live-marks-crepe.md')
    await mine.getByRole('button', { name: '结束协作' }).click()
    await expect(mine.locator('.ink-live-card')).toContainText('协作已结束', { timeout: 15_000 })
  } finally {
    await owner.close()
  }
})
