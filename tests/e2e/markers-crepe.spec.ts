import { expect, test, type Page } from '@playwright/test'

/**
 * The syntax of whatever the caret is in.
 *
 * Typora and the previous engine both show it, and it is most of what makes a markdown editor feel
 * like markdown rather than like a word processor. This engine showed a toolbar instead.
 *
 * The assertions are deliberately about two things at once: what is on screen, and that the file on
 * disk is byte-identical afterwards. The markers are decorations — the document is never touched —
 * and that is the property worth holding, because the alternative (replacing the text with its own
 * markdown, as links and pictures do) would put literal asterisks in reach of every save.
 */

async function open(page: Page, note = 'marks-crepe.md', expectText = 'bold text') {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText(expectText, { timeout: 15_000 })
}

/** Put the caret inside the first occurrence of `word`, without selecting anything. */
async function caretIn(page: Page, word: string) {
  await page.evaluate((needle) => {
    const walk = document.createTreeWalker(document.querySelector('.ink-doc')!, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walk.nextNode()) !== null) {
      const at = (node.textContent ?? '').indexOf(needle)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at + 1)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
  }, word)
  await page.waitForTimeout(200)
}

const markers = (page: Page) =>
  page.$$eval('.ink-marker', (nodes) => nodes.map((n) => n.textContent))

const read = (page: Page, path: string) => page.evaluate(async (p) => {
  const res = await fetch(`/api/file?path=${encodeURIComponent(p)}`)
  return (await res.json() as { content: string }).content
}, path)

/** The paragraph as it reads on screen, syntax and all. */
const line = (page: Page) => page.locator('.ink-doc p').last().innerText()

test('the run the caret is in shows its own markdown, and only it', async ({ page }) => {
  await open(page)

  await caretIn(page, 'bold text')
  expect(await line(page)).toContain('**bold text**')
  // Only that one: the others are still bold, italic, struck out and code.
  expect(await line(page)).not.toContain('*italic text*')
  expect(await line(page)).not.toContain('`inline code`')

  await caretIn(page, 'inline code')
  expect(await line(page)).toContain('`inline code`')
  expect(await line(page)).not.toContain('**bold text**')

  // Out of every run: nothing is spelled out.
  await caretIn(page, 'A paragraph with')
  expect(await line(page)).not.toContain('**')
  expect(await line(page)).not.toContain('`')

  // A heading keeps its own, in the gutter, which is a decoration and not text.
  await caretIn(page, 'Heading two')
  expect(await markers(page)).toEqual(['##'])
})

test('a heading shows its own level, in the gutter', async ({ page }) => {
  await open(page)

  const before = await page.evaluate(() =>
    Math.round(document.querySelector('.ink-doc h2')!.getBoundingClientRect().left))

  await caretIn(page, 'Heading two')
  expect(await markers(page)).toEqual(['##'])

  const geometry = await page.evaluate(() => {
    const marker = document.querySelector('.ink-marker--heading')!.getBoundingClientRect()
    const heading = document.querySelector('.ink-doc h2')!.getBoundingClientRect()
    return { markerRight: Math.round(marker.right), headingLeft: Math.round(heading.left) }
  })

  // In the gutter, to the left of the text — and the heading has not moved to make room for it.
  expect(geometry.markerRight).toBeLessThanOrEqual(geometry.headingLeft)
  expect(await page.evaluate(() =>
    Math.round(document.querySelector('.ink-doc h2')!.getBoundingClientRect().left))).toBe(before)

  await caretIn(page, 'Heading one')
  expect(await markers(page)).toEqual(['#'])
})

test('reading a note shows none of it', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Read' }).click()
  await caretIn(page, 'bold text')
  expect(await markers(page)).toEqual([])
})

test('visiting every one of them changes nothing on disk', async ({ page }) => {
  await open(page)
  const before = await read(page, 'notes/marks-crepe.md')

  for (const word of ['bold text', 'italic text', 'struck out', 'inline code']) {
    await caretIn(page, word)
    expect(await line(page)).toContain(word)
  }
  await caretIn(page, 'Heading two')
  expect((await markers(page)).length).toBeGreaterThan(0)

  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(500)
  // A run showing its own markdown holds literal asterisks, so the save closes it first — that is
  // `collapseMarks`, and this is the assertion that it happens.
  expect(await read(page, 'notes/marks-crepe.md')).toBe(before)
})

/**
 * The backslashes a serialiser adds, and the two it keeps.
 *
 * `\*\*6\*\*` is how a file says "the characters, not bold", and writing it back that way is
 * technically correct and useless: it is a backslash the reader never typed, github.com renders it
 * as literal asterisks, and a reader who typed `**6**` meant bold. A line-leading `* ` is different
 * in kind — unescaping it turns a paragraph into a list — so that one stays.
 */
test('a save does not add backslashes to what was typed', async ({ page }) => {
  // Written here rather than in the fixture: this test is about what a save *changes*, so it has to
  // start from a file it knows the spelling of, whatever earlier tests did to the vault.
  await open(page)
  await page.evaluate(async () => {
    await fetch('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'notes/escapes-crepe.md',
        content: 'Literal \\*\\*6\\*\\* in a sentence.\n\n\\* not a bullet\n\nIt costs $5 today.\n',
      }),
    })
  })
  // Reloaded rather than waited on: the tree learns about a new file from the watcher, which has a
  // grace period, and this test is not about that.
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^escapes-crepe\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('in a sentence', { timeout: 15_000 })

  // Any edit at all, so there is something to save.
  await caretIn(page, 'in a sentence')
  await page.keyboard.type('!')
  await page.waitForTimeout(400)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(600)

  const saved = await read(page, 'notes/escapes-crepe.md')
  // What was typed, with no backslash in front of it.
  expect(saved).toContain('**6**')
  expect(saved).not.toContain('\\*\\*6')
  // …and the bullet keeps its own, because unescaping that one changes a paragraph into a list.
  expect(saved).toContain('\\* not a bullet')
  // A dollar sign is the same story since maths was turned on: `costs \$5` is a backslash nobody
  // typed. The line is read as maths next time, here and on github.com, which is what `$` means in
  // a file that has formulas in it.
  expect(saved).toContain('costs $5')
  expect(saved).not.toContain('\\$5')
})

/**
 * The character reference a trailing space came back as.
 *
 * `&#x20;` is the serialiser being right and useless: markdown cannot hold a space at a line
 * boundary, so it writes an entity to keep one. Nobody types a trailing space on purpose — it is
 * what is left after a word — and the cost of keeping it is an entity in the middle of a sentence,
 * in a file read on github.com and in other editors.
 */
test('a trailing space does not come back as an entity', async ({ page }) => {
  await open(page)
  await caretIn(page, 'A paragraph with')
  await page.keyboard.press('End')
  await page.keyboard.type(' and a trailing space ')
  await page.waitForTimeout(400)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)

  const saved = await read(page, 'notes/marks-crepe.md')
  expect(saved).toContain('and a trailing space')
  expect(saved).not.toContain('&#x20;')
  // Dropped rather than kept as a literal, which would be trailing whitespace in git and would go
  // on the next parse anyway — a diff nobody made.
  expect(saved).not.toMatch(/ \n/)
})

/**
 * Shift+Enter is a line break, not a new paragraph.
 *
 * Measured before it existed: this application had no soft break at all in the default engine —
 * the browser's contenteditable default splits the `<p>`, so Shift+Enter made a paragraph, and a
 * paragraph carries the paragraph margin. There was no way to write two tight lines.
 */
test('shift+enter writes a line break, not a paragraph', async ({ page }) => {
  await open(page)
  await caretIn(page, 'A paragraph with')
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('a second line')
  await page.waitForTimeout(500)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)

  const saved = await read(page, 'notes/marks-crepe.md')
  // A hard break, which is what github.com and Typora both read as a line break.
  expect(saved).toMatch(/\\\na second line/)
  // Not a paragraph: there is no blank line before it.
  expect(saved).not.toMatch(/\n\na second line/)
})

/**
 * Every position in the source, one arrow key each.
 *
 * `x \`a\`+ *b*` has eleven of them and the document has eight: the two ends of each run are one
 * position wearing two meanings, and which one it is decides whether what is typed next is inside
 * the run or after it. Both halves of the same report came from there — at the end of `*b*`
 * everything typed came out italic and there was no way out, and after `` `a` `` everything typed
 * came out plain and there was no way in.
 */
async function walkRight(page: Page, steps: number) {
  await page.locator('.ink-doc p').first().click()
  await page.keyboard.press('Home')
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(120)
  }
}

/** What the note holds afterwards is the only unambiguous answer: a marker is drawn *inside* the
 * element it belongs to, so the rendered text of an `<em>` includes it. */
async function save(page: Page, note: string): Promise<string> {
  await page.waitForTimeout(300)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  return read(page, `notes/${note}`)
}

async function clickPastTheEnd(page: Page) {
  const box = (await page.locator('.ink-doc p').first().boundingBox())!
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2)
  await page.waitForTimeout(250)
}

test('the arrow keys reach the position inside a run against its closing marker', async ({ page }) => {
  await open(page, 'steps1-crepe.md', 'x ')
  // x(1) space(2) `(3) a(4) — the fourth press lands between the `a` and its closing backtick,
  // which is the position that did not exist before: a code run could not be added to.
  await walkRight(page, 4)
  await page.keyboard.type('X')
  expect(await save(page, 'steps1-crepe.md')).toContain('`aX`')
})

test('and the one after it, which is not in the run', async ({ page }) => {
  await open(page, 'steps2-crepe.md', 'x ')
  await walkRight(page, 5)
  await page.keyboard.type('X')
  expect(await save(page, 'steps2-crepe.md')).toContain('`a`X+')
})

test('a click past the end of a line is after what the line ends with', async ({ page }) => {
  await open(page, 'steps3-crepe.md', 'x ')
  await clickPastTheEnd(page)
  // Emphasis used to be inclusive, so this typed inside the `*` and nothing could get out.
  await page.keyboard.type('X')
  expect(await save(page, 'steps3-crepe.md')).toContain('*b*X')
})

test('and one step to the left of it is inside the emphasis', async ({ page }) => {
  await open(page, 'steps4-crepe.md', 'x ')
  await clickPastTheEnd(page)
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(200)
  await page.keyboard.type('Y')
  expect(await save(page, 'steps4-crepe.md')).toContain('*bY*')
})


/**
 * A marker taken out ends the run, at once.
 *
 * Waiting for the caret to leave before saying so left the text sitting in a code chip the document
 * no longer had any reason to draw: `` `aaa `` is not code, and it looked like code until the focus
 * moved. A marker is the thing that makes a run.
 */
test('deleting a marker turns the run back into text while the caret is still in it', async ({ page }) => {
  await open(page, 'damage-crepe.md', 'aaa')
  await expect(page.locator('.ink-doc p code')).toHaveCount(1)

  // Into the run, which opens it, and then to the end of its text — the closing backtick.
  await page.locator('.ink-doc p code').first().click()
  await page.waitForTimeout(300)
  await expect(page.locator('.ink-doc p')).toContainText('`aaa`')
  await page.evaluate(() => {
    const text = document.querySelector('.ink-doc p code')!.firstChild!
    const range = document.createRange()
    range.setStart(text, text.textContent!.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.waitForTimeout(250)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(400)

  // Not code any more, without the caret having gone anywhere.
  await expect(page.locator('.ink-doc p code')).toHaveCount(0)
  await expect(page.locator('.ink-doc p')).toContainText('`aaa end')

  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  expect(await read(page, 'notes/damage-crepe.md')).toContain('`aaa end')
})

/**
 * Backspacing from the end of a line into a run opens it.
 *
 * `` `aaa`111 `` deleted from the right used to eat `111` and then `aaa`, walking straight past the
 * backticks — they were never characters, so there was nothing to delete. The guard that refused to
 * open on any change to the document was in the way; the question is whether *this run* was there
 * before, not whether anything was typed.
 */
test('backspacing into a run opens it, and the next one takes a marker', async ({ page }) => {
  await open(page, 'deltail-crepe.md', 'aaa')
  await page.locator('.ink-doc p').first().click()
  await page.keyboard.press('End')
  await page.waitForTimeout(300)

  for (const _ of [0, 1, 2]) {
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(250)
  }
  // The `111` is gone and the run has opened, backticks and all.
  await expect(page.locator('.ink-doc p')).toContainText('`aaa`')
  await expect(page.locator('.ink-doc p code')).toHaveCount(1)

  // The next Backspace is the closing marker, which ends the run.
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  await expect(page.locator('.ink-doc p code')).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  expect(await read(page, 'notes/deltail-crepe.md')).toContain('`aaa')
})

/**
 * `:tada:` becomes an emoji as it is typed, and a shortcode already in a file does not.
 *
 * The other engine renders both, which means writing the emoji back into the note on the next save
 * — the file rewritten for something nobody typed today. The shortcut helps you write one; what is
 * on disk stays what was typed.
 */
test('a shortcode typed becomes an emoji, and one already written stays', async ({ page }) => {
  await open(page, 'emoji-crepe.md', 'An existing')

  await page.locator('.ink-doc p').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' typed :tada: here', { delay: 40 })
  await page.waitForTimeout(400)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)

  const saved = await read(page, 'notes/emoji-crepe.md')
  // What was typed became the character, with the space in front of it intact.
  expect(saved).toContain('typed 🎉 here')
  // And what was already there is untouched.
  expect(saved).toContain('An existing :smile: stays.')
})
