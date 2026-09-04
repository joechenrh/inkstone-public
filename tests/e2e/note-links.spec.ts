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

/**
 * Two ways the source form got stuck, both reported from real use.
 *
 * A link shows its own markdown while the caret is in it and folds back into a link when the caret
 * leaves. Both of these left the markdown on the screen for good — and the second wrote it to the
 * file as `[one](https\://…)`, escaped into something that can never render again.
 */
async function threeLinks(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.evaluate(async () => {
    await fetch('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'notes/linkrows.md',
        content: '# Links\n\n- [one](https://example.com/one)\n- [two](https://example.com/two)\n'
          + '- [three](https://example.com/three)\n\nPlain paragraph.\n',
      }),
    })
  })
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^linkrows\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('Plain paragraph.', { timeout: 15_000 })
}

/** The line that is showing its markdown, if any. */
const openLine = (page: Page) => page.locator('.ink-doc').innerText()
  .then((t) => t.split('\n').find((l) => l.includes('](')) ?? null)

test('clicking from one link straight to the next opens the next one', async ({ page }) => {
  await threeLinks(page)

  /*
   * Every one of them, in a row. The second used to do nothing: ProseMirror hands a plugin the
   * transactions it has not seen yet, and one the plugin appended itself is not among them — so
   * the round that folded the first link up was the only round there was, and the click that
   * asked for the second link was spent on closing the first.
   */
  for (const name of ['one', 'two', 'three']) {
    await page.locator('.ink-doc a').filter({ hasText: name }).first().click()
    await page.waitForTimeout(350)
    expect(await openLine(page), `clicking ${name} did not show its markdown`)
      .toContain(`[${name}](https://example.com/${name})`)
  }

  // And only ever one at a time.
  expect((await page.locator('.ink-doc').innerText()).split('\n').filter((l) => l.includes('](')))
    .toHaveLength(1)
})

test('a character typed after the closing paren is not part of the link', async ({ page }) => {
  await threeLinks(page)
  await page.locator('.ink-doc a').filter({ hasText: 'one' }).first().click()
  await page.waitForTimeout(350)
  expect(await openLine(page)).toContain('[one](https://example.com/one)')

  // The link is the whole list item, so End is exactly one place: just after the `)`.
  await page.keyboard.press('End')
  await page.waitForTimeout(200)
  await page.keyboard.type(':')
  await page.waitForTimeout(400)

  // Typing outside it is leaving it: the markdown folds away there and then.
  expect(await openLine(page), 'the source stayed open around a character typed outside it').toBeNull()
  await expect(page.locator('.ink-doc a').filter({ hasText: 'one' })).toHaveCount(1)

  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(900)
  const saved = await page.evaluate(async () => {
    const res = await fetch(`/api/file?path=${encodeURIComponent('notes/linkrows.md')}`)
    return (await res.json() as { content: string }).content
  })
  expect(saved).toContain('- [one](https://example.com/one):')
  // Never the escaped form, which is a link that can never render again.
  expect(saved).not.toContain('\\:')
  expect(saved).not.toContain('\\[')
})

/** A note whose link is the last thing on its line, which is where both of these went wrong. */
async function linkAtLineEnd(page: Page, content: string) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.evaluate(async (body) => {
    await fetch('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'notes/linkend.md', content: body }),
    })
  }, content)
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^linkend\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('End', { timeout: 15_000 })
}

test('clicking past the end of a line leaves the link it ends with alone', async ({ page }) => {
  await linkAtLineEnd(page, '# End\n\nA line ending in [xxx](https://example.com/x)\n')
  const para = page.locator('.ink-doc p').filter({ hasText: 'A line ending' }).first()
  const box = (await para.boundingBox())!

  // The empty space after the last character, which is where a reader aims to get to the end of a
  // line. It resolves to the position at the end of the link, and being *at* the end used to count
  // as being inside: the link unfolded and the caret landed in its brackets, at `[xxx|](…)`.
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2)
  await page.waitForTimeout(400)
  await expect(page.locator('.ink-doc')).not.toContainText('](')
  await expect(page.locator('.ink-doc a')).toHaveCount(1)
})

test('Enter at a link that is showing its source makes the next list item', async ({ page }) => {
  await linkAtLineEnd(page, '# End\n\n- item one [xxx](https://example.com/x)\n- item two\n')
  await page.locator('.ink-doc a').first().click()
  await page.waitForTimeout(400)
  await expect(page.locator('.ink-doc')).toContainText('[xxx](https://example.com/x)')

  /*
   * The plugin closes the link and stands aside. It used to do the split itself, and a plain split
   * inside a list item makes a second paragraph in the *same* item — so Enter here produced a blank
   * line rather than the next item. Enter belongs to the editor, which knows what a list is.
   */
  await page.keyboard.press('Enter')
  await page.keyboard.type('typed')
  await page.waitForTimeout(400)

  await expect(page.locator('.ink-doc li')).toHaveCount(3)
  await expect(page.locator('.ink-doc li').nth(1)).toContainText('typed')
  // And the link came back whole, rather than being split down the middle.
  await expect(page.locator('.ink-doc a').filter({ hasText: 'xxx' })).toHaveCount(1)
  await expect(page.locator('.ink-doc')).not.toContainText('](')
})
