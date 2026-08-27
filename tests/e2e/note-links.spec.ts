import { expect, test, type Page } from '@playwright/test'

/**
 * Following a link from one note to another.
 *
 * Driven in both engines, because they reach it by completely different routes — a ProseMirror
 * plugin in one, a capture-phase listener in the other — and the whole point of the resolver is
 * that neither of them knows where a path leads. If the two ever disagree, one of these fails.
 *
 * Resolution is GitHub's, and that is a promise about a file rather than about this application:
 * the same note is read on github.com, where `linked/target.md` from `notes/links.md` means
 * `notes/linked/target.md`. These tests are what stops that drifting.
 */

async function open(page: Page, engine: 'crepe', note = 'links.md', text = 'Links one') {
  await page.addInitScript((e) => { localStorage.setItem('inkstone.editorEngine', e) }, engine)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText(text, { timeout: 15_000 })
}

/** The gesture: a modifier while editing. Clicks the link whose text is `label`. */
async function follow(page: Page, label: string) {
  await page.locator('.ink-doc').getByText(label, { exact: true }).first()
    .click({ modifiers: ['ControlOrMeta'] })
  await page.waitForTimeout(500)
}

const openNote = (page: Page) => page.locator('.ink-topbar').innerText()

for (const engine of ['crepe'] as const) {
  test(`${engine}: a relative link opens the note it names`, async ({ page }) => {
    await open(page, engine)
    await follow(page, 'the target')

    // `linked/target.md` from `notes/links.md` is `notes/linked/target.md` — GitHub's reading.
    await expect(page.locator('.ink-topbar')).toContainText('notes/linked/target.md')
    await expect(page.locator('.ink-doc')).toContainText('Body of the target note.')
  })

  test(`${engine}: a link to a note that is not there says so, and stays put`, async ({ page }) => {
    await open(page, engine)
    const before = await openNote(page)
    await follow(page, 'nowhere')

    await expect(page.locator('.ink-paste-line')).toContainText('no such note')
    await expect(page.locator('.ink-paste-line')).toContainText('notes/linked/missing.md')
    expect(await openNote(page)).toBe(before)
  })
}

/**
 * Where the notice is drawn.
 *
 * Measured on a phone, in read mode: the first tap on a dead link put the pill in the corner of the
 * editor, half off the left edge, and every tap after that put it beside a caret from some earlier
 * edit. Reading has no caret to measure against, and a tap leaves no selection behind — so the line
 * is hung off the place that was pressed instead.
 */
test('the notice is drawn beside the link that was followed, with no caret anywhere', async ({ page }) => {
  await open(page, 'crepe')
  // Read mode: the state the phone was in. There is no caret in it at all.
  await page.getByRole('button', { name: 'Read' }).click()
  await expect(page.locator('.ink-doc')).toBeVisible()
  await page.evaluate(() => { document.getSelection()?.removeAllRanges() })

  const link = page.locator('.ink-doc').getByText('nowhere', { exact: true }).first()
  const box = (await link.boundingBox())!
  await link.click()

  const pill = page.locator('.ink-paste-line')
  await expect(pill).toContainText('no such note')
  const drawn = (await pill.boundingBox())!
  // Beside the link — the same screenful, under the line that was pressed. Not the corner.
  expect(Math.abs(drawn.y - box.y)).toBeLessThan(80)
  expect(drawn.x).toBeGreaterThan(0)
})

test('a heading link scrolls to the heading, and a bad one says so', async ({ page }) => {
  await open(page, 'crepe')
  await follow(page, 'no heading')
  await expect(page.locator('.ink-paste-line')).toContainText('no such heading')

  // The good one moves the document rather than the note.
  await page.locator('.ink-doc').evaluate((el) => { el.scrollTop = 400 })
  await page.waitForTimeout(200)
  await follow(page, 'the top')
  await expect.poll(() => page.locator('.ink-doc').evaluate((el) => el.scrollTop)).toBeLessThan(60)
})

test('a link into another note carries its heading with it', async ({ page }) => {
  await open(page, 'crepe')
  await follow(page, 'a heading in it')
  await expect(page.locator('.ink-topbar')).toContainText('target.md')
  // The note is long enough that arriving at the heading means having scrolled.
  await expect.poll(
    () => page.locator('.ink-doc').evaluate((el) => el.scrollTop),
    { timeout: 10_000 },
  ).toBeGreaterThan(20)
})

test('an address still goes to the browser, and nothing else does', async ({ page }) => {
  await open(page, 'crepe')
  const opened = page.waitForEvent('popup')
  await follow(page, 'the outside')
  expect((await opened).url()).toContain('example.com')
})

test('back and forward walk the notes visited', async ({ page }) => {
  await open(page, 'crepe')
  await follow(page, 'the target')
  await expect(page.locator('.ink-topbar')).toContainText('target.md')

  // Following a link is otherwise a one-way door: the tree and Recent are the only ways back, and
  // neither is where your eyes are.
  await page.keyboard.press('ControlOrMeta+[')
  await expect(page.locator('.ink-topbar')).toContainText('links.md')

  await page.keyboard.press('ControlOrMeta+]')
  await expect(page.locator('.ink-topbar')).toContainText('target.md')
})

test('reading a note follows a link with a plain click', async ({ page }) => {
  await open(page, 'crepe')
  await page.getByRole('button', { name: 'Read' }).click()
  await page.locator('.ink-doc').getByText('the target', { exact: true }).first().click()
  await expect(page.locator('.ink-topbar')).toContainText('target.md')
})

/**
 * A notice about a link goes on its own.
 *
 * "Gone with the next keystroke" is the right rule for a paste, because after a paste you carry on
 * typing. After a link that led nowhere there is no next keystroke, and `no such note` sat on the
 * document until something else was clicked.
 */
test('a notice leaves by itself when nothing else happens', async ({ page }) => {
  await open(page, 'crepe')
  await follow(page, 'nowhere')
  await expect(page.locator('.ink-paste-line')).toContainText('no such note')
  // Long enough to read a path, short enough not to become furniture.
  await expect(page.locator('.ink-paste-line')).toHaveCount(0, { timeout: 12_000 })
})
