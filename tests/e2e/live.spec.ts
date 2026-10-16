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
  // Scoped to the panel: a note called `emojistart-crepe.md` has a row button whose label
  // contains the word too.
  await page.locator('.ink-share').getByRole('button', { name: 'Start' }).click()
  // The link is selectable text beside one button, as the share panel's is — not a boxed input.
  const link = page.locator('.ink-share-url .ink-share-urltext')
  await expect(link).toContainText('/live/', { timeout: 15_000 })
  const url = `http://${(await link.innerText()).trim()}`
  expect(url).toMatch(/\/live\/[abcdefghjkmnpqrstuvwxyz23456789]{6}$/)
  return url
}

/** Out of the panel and back to the note. The panel is modal: it covers the document. */
async function closePanel(page: Page) {
  await page.getByRole('button', { name: 'Close live share' }).click()
  await expect(page.locator('.ink-share')).toHaveCount(0)
}

/** Back into it, from the note's own menu — which is where a running session is reached. */
async function reopenPanel(page: Page, note: string) {
  const row = page.locator('.ink-tree-row').filter({ hasText: note })
  await row.hover()
  await page.getByRole('button', { name: `Actions for ${note}` }).click()
  // The menu's item, not the status bar's text: both say the same thing, which is the point of
  // the state being the label, and a bare text match picks up whichever it finds first.
  await page.getByRole('menuitem', { name: /^Live · / }).click()
  await expect(page.locator('.ink-share')).toContainText('End session')
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
    await expect(theirs.locator('.ink-live-join')).toContainText('edit together')
    await theirs.locator('#ink-live-name').fill('Lin')
    await theirs.getByRole('button', { name: 'Join' }).click()

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
    await expect(mine.locator('.ink-live-who')).toContainText('Lin')

    // Ending saves what the two of them wrote, and tells the guest so.
    await mine.getByRole('button', { name: 'End session' }).click()
    await expect(mine.locator('.ink-share')).toContainText('Session ended', { timeout: 15_000 })
    await expect(theirs.locator('.ink-live-said')).toContainText('has ended', { timeout: 15_000 })

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

/**
 * Every socket this app opens is under `/ws`.
 *
 * Not a style rule: a reverse proxy only forwards an upgrade on the paths it was told about, and
 * the deployment's nginx has one `location /ws`. The session socket lived at `/live-ws/<id>` for
 * one release — every test passed, and in production every session reported "connection lost",
 * because nginx proxied the handshake as an ordinary request. There is no nginx in this suite, so
 * the invariant it depends on is what gets asserted.
 */
test('every socket is under /ws, which is the one path a proxy is told about', async ({ browser }) => {
  const owner = await browser.newContext()
  const guest = await browser.newContext()
  const mine = await owner.newPage()
  const theirs = await guest.newPage()
  const opened: string[] = []
  mine.on('websocket', (ws) => { opened.push(ws.url()) })
  theirs.on('websocket', (ws) => { opened.push(ws.url()) })

  try {
    await signIn(mine, 'live-ws-crepe.md', 'Before.')
    const url = await startSession(mine, 'live-ws-crepe.md')
    await closePanel(mine)
    await theirs.goto(url)
    await theirs.locator('#ink-live-name').fill('Lin')
    await theirs.getByRole('button', { name: 'Join' }).click()
    await expect(theirs.locator('.ink-doc')).toContainText('Before.', { timeout: 15_000 })

    expect(opened.length, 'no socket was opened at all').toBeGreaterThan(1)
    for (const one of opened) {
      expect(new URL(one).pathname, one).toMatch(/^\/ws(\/|$)/)
    }

    // Ended, not merely abandoned: one session per account, and the next test is the same account.
    await reopenPanel(mine, 'live-ws-crepe.md')
    await mine.getByRole('button', { name: 'End session' }).click()
    await expect(mine.locator('.ink-share')).toContainText('Session ended', { timeout: 15_000 })
  } finally {
    await owner.close()
    await guest.close()
  }
})

/**
 * A session is visible on the owner's own screen, in both bars.
 *
 * The first version had neither mark: a session looked exactly like no session, and the only way to
 * tell was to open the menu. Reported as the interface losing what the design had at the top and
 * the bottom — which it had. Both are also the way back into the panel.
 */
test('a running session shows in the top bar and the status bar, and is the way back in', async ({ browser }) => {
  const owner = await browser.newContext()
  const guest = await browser.newContext()
  const mine = await owner.newPage()
  const theirs = await guest.newPage()

  try {
    await signIn(mine, 'live-marks2-crepe.md', 'Before.')
    // Neither mark before there is a session, rather than an empty one.
    await expect(mine.locator('.ink-live-mark')).toHaveCount(0)
    await expect(mine.locator('.ink-live-status')).toHaveCount(0)

    const url = await startSession(mine, 'live-marks2-crepe.md')
    await closePanel(mine)
    await expect(mine.locator('.ink-live-mark')).toContainText('Live')
    await expect(mine.locator('.ink-live-status')).toContainText('Live ·')
    // And what the session is doing to the note, said rather than left as an absence.
    await expect(mine.locator('.ink-live-status')).toContainText('saving when the session ends')

    // A guest arriving is a face in the bar, with no panel open.
    await theirs.goto(url)
    await theirs.locator('#ink-live-name').fill('Lin')
    await theirs.getByRole('button', { name: 'Join' }).click()
    await expect(theirs.locator('.ink-doc')).toContainText('Before.', { timeout: 15_000 })
    await expect(mine.locator('.ink-live-mark .ink-live-face')).toHaveCount(1, { timeout: 15_000 })
    await expect(mine.locator('.ink-live-status')).toContainText('1 person')

    // The mark is the way back in: the state is the control, as sharing's menu item is.
    await mine.locator('.ink-live-mark').click()
    await expect(mine.locator('.ink-share')).toContainText('End session')
    await mine.getByRole('button', { name: 'End session' }).click()
    await expect(mine.locator('.ink-share')).toContainText('Session ended', { timeout: 15_000 })
    await closePanel(mine)

    // And both go when it ends.
    await expect(mine.locator('.ink-live-mark')).toHaveCount(0)
    await expect(mine.locator('.ink-live-status')).toHaveCount(0)
  } finally {
    await owner.close()
    await guest.close()
  }
})

/**
 * A session belongs to one note, and the editor for every other note is the ordinary one.
 *
 * The first version passed the session's document to whatever was open, so opening a second note
 * during a session left the editor bound to the session — every word typed into the other note went
 * into the shared one, and the other note's own text was never on screen at all.
 */
test('another note opened during a session is that note, not the session', async ({ browser }) => {
  const owner = await browser.newContext()
  const mine = await owner.newPage()
  try {
    await signIn(mine, 'live-other-crepe.md', 'Elsewhere.')
    await startSession(mine, 'live-other-crepe.md')
    await closePanel(mine)

    // A different note, while the session runs.
    await mine.locator('.ink-tree-name').filter({ hasText: /^live-second-crepe\.md$/ }).click()
    await expect(mine.locator('.ink-doc')).toContainText('Before.', { timeout: 15_000 })
    await expect(mine.locator('.ink-doc')).not.toContainText('Elsewhere.')
    // And it does not claim to be live: the marks belong to the session's note, not to the app.
    await expect(mine.locator('.ink-live-mark')).toHaveCount(0)
    await expect(mine.locator('.ink-live-status')).toHaveCount(0)

    // And it is the ordinary editor: the syntax reveals itself, which it never does in a session.
    await caretAfter(mine, 'Before.')
    await mine.keyboard.type(' **bold**')
    await mine.waitForTimeout(400)
    await mine.locator('.ink-doc strong').first().click()
    await mine.waitForTimeout(400)
    await expect(mine.locator('.ink-doc')).toContainText('**bold**')

    await reopenPanel(mine, 'live-other-crepe.md')
    await mine.getByRole('button', { name: 'End session' }).click()
    await expect(mine.locator('.ink-share')).toContainText('Session ended', { timeout: 15_000 })
  } finally {
    await owner.close()
  }
})

test('a link that is not a session says so, in one sentence for every reason', async ({ page }) => {
  await page.goto('/live/zzzzzz')
  await expect(page.locator('.ink-shared-gone-title')).toContainText('does not work')
  // And nothing about which note, which account, or whether it ever existed.
  await expect(page.locator('.ink-shared-gone')).not.toContainText('notes/')
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
    await mine.getByRole('button', { name: 'End session' }).click()
    await expect(mine.locator('.ink-share')).toContainText('Session ended', { timeout: 15_000 })
  } finally {
    await owner.close()
  }
})
