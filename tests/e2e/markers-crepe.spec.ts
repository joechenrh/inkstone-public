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
 * `:tada:` is drawn as 🎉 and stays `:tada:` in the file.
 *
 * The first version replaced the shortcode with the character as it was typed, which is not what
 * Typora does and not what this application's rule allows: there the shortcode is the text, the
 * emoji is drawn over it, and the caret in it shows `:tada:` in grey beside the picture — the same
 * rule as every other bit of syntax here. So the bytes on disk are the six characters somebody
 * typed, whichever editor opens them next.
 */
test('a shortcode is drawn as its emoji and stays in the file', async ({ page }) => {
  await open(page, 'emoji-crepe.md', 'An existing')

  // Drawn beside the shortcode, which is itself collapsed to nothing.
  await expect(page.locator('.ink-doc .ink-emoji-glyph-drawn').first()).toHaveText('😄')
  const shortcode = page.locator('.ink-doc .ink-emoji').first()
  expect(await shortcode.evaluate((el) => getComputedStyle(el).fontSize)).toBe('0px')

  // The caret in it shows the shortcode, in grey, beside what it draws.
  await page.evaluate(() => {
    const span = document.querySelector('.ink-emoji')!
    const text = document.createTreeWalker(span, NodeFilter.SHOW_TEXT).nextNode()!
    const range = document.createRange()
    range.setStart(text, 3)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.waitForTimeout(300)
  await expect(page.locator('.ink-doc .ink-emoji--open')).toHaveCount(1)

  // And the file is what it was.
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  expect(await read(page, 'notes/emoji-crepe.md')).toContain('An existing :smile: stays.')
})

/**
 * The list that offers shortcodes, because nobody remembers the name of an emoji.
 *
 * What it inserts is the shortcode rather than the character, for the reason above.
 */
/**
 * The emoji and the colon after it are one unit: there is no caret stop between them, wherever the
 * shortcode is. It was a widget that made that true everywhere — as the span's own `::before` the
 * picture lived *inside* the span, and at the start of a paragraph the caret has nowhere else to
 * go, so a shortcode that opened a line had a stop that the same shortcode mid-line did not.
 */
test('the emoji and its colon are one step, at the start of a line too', async ({ page }) => {
  await open(page, 'emojistart-crepe.md', 'at the start')

  await page.locator('.ink-doc p').first().click()
  await page.keyboard.press('Home')
  await page.waitForTimeout(200)
  // Before everything: outside the shortcode's own span, which is what puts it before the picture.
  expect(await page.evaluate(() => {
    const node = getSelection()?.focusNode
    const element = node instanceof Element ? node : node?.parentElement
    return element?.closest('.ink-emoji') !== null
  })).toBe(false)

  // One press, and the caret is past both the picture and the colon.
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)
  expect(await page.evaluate(() => {
    const selection = getSelection()!
    return { inside: (selection.focusNode?.parentElement)?.closest('.ink-emoji') !== null, offset: selection.focusOffset }
  })).toEqual({ inside: true, offset: 1 })
})

test('typing a colon and two letters offers the shortcodes they start', async ({ page }) => {
  await open(page, 'emoji-crepe.md', 'An existing')

  await page.locator('.ink-doc p').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' :ta', { delay: 60 })
  await page.waitForTimeout(500)

  const menu = page.locator('.ink-emoji-menu')
  await expect(menu).toBeVisible()
  // Alphabetical, so the order is one a reader can predict.
  await expect(menu.locator('.ink-emoji-row').first()).toContainText(':taco:')
  await expect(menu.locator('.ink-emoji-row--active')).toHaveCount(1)

  // Down to the second, and take it.
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(200)
  await expect(menu.locator('.ink-emoji-row--active')).toContainText(':tada:')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)

  // Gone, and the shortcode is in the document — drawn, but spelled out in the file.
  await expect(menu).toBeHidden()
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)
  expect(await read(page, 'notes/emoji-crepe.md')).toContain(':tada:')
})

/**
 * The list corrects a shortcode as well as finishing one.
 *
 * Taking an offer while standing inside `:tada:` used to leave the closing colon that was already
 * there, so the line came out `:tada::` — the replacement ran to the caret rather than to the end
 * of the shortcode being edited.
 */
test('taking an offer inside a shortcode replaces all of it', async ({ page }) => {
  await open(page, 'emojiedit-crepe.md', 'x ')

  // `x :ta|da: y` — two letters in, where the offer is for `ta`.
  await page.locator('.ink-doc p').first().click()
  await page.keyboard.press('Home')
  for (const _ of [0, 1, 2, 3, 4]) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(100)
  }
  await page.waitForTimeout(400)
  await expect(page.locator('.ink-emoji-menu')).toBeVisible()
  await expect(page.locator('.ink-emoji-row').first()).toContainText(':taco:')

  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(700)

  const saved = await read(page, 'notes/emojiedit-crepe.md')
  expect(saved).toContain('x :taco: y')
  expect(saved).not.toContain('::')
})

/**
 * Syntax typed *around* text, rather than into it.
 *
 * `**bold**` typed left to right becomes a mark on the last asterisk, by an input rule. Typed the
 * other way — the four stars first, the word after — no rule can fire: an input rule matches what is
 * behind the caret and the closing pair is in front of it. The asterisks stayed literal for ever.
 * Reported.
 */
test('crepe: stars first, the word after, and it is still bold', async ({ page }) => {
  await open(page)
  await page.locator('.ink-doc').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')

  await page.keyboard.type('****')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('bold')
  await page.waitForTimeout(400)

  // While the caret is in it, it shows its own markers — the same as every other open run.
  await expect(page.locator('.ink-doc')).toContainText('**bold**')

  // Out of it, and it is emphasis rather than four asterisks.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type(' after')
  await page.waitForTimeout(400)
  // Exactly this word: the note already carries a `bold text` of its own.
  await expect(page.locator('.ink-doc strong').filter({ hasText: /^bold$/ })).toHaveCount(1)
  await expect(page.locator('.ink-doc')).not.toContainText('**bold**')
})

test('crepe: walking a caret through literal asterisks leaves them alone', async ({ page }) => {
  await open(page)
  /*
   * A note *about* markdown holds `\*\*not bold\*\*` — escaped in the file, plain text in the
   * document. Only a round that changed the document may close a pair, or moving a caret through
   * somebody's literal asterisks would quietly turn them into emphasis.
   */
  await page.evaluate(async () => {
    await fetch('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'notes/literal.md', content: '# Literal\n\nsee \\*\\*not bold\\*\\* here\n' }),
    })
  })
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^literal\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('not bold', { timeout: 15_000 })

  // Into the middle of them, with the arrow keys, changing nothing.
  await page.locator('.ink-doc p').filter({ hasText: 'not bold' }).first().click()
  await page.keyboard.press('Home')
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(400)

  await expect(page.locator('.ink-doc strong')).toHaveCount(0)
  await expect(page.locator('.ink-doc')).toContainText('**not bold**')
})

/**
 * What leaves on the clipboard is the closed form.
 *
 * While something is revealed the document really holds its markdown: a bold run holds `**aa**`
 * with the asterisks wearing the bold, and a link holds a literal `[a](b)`. So a copy took the
 * syntax with it — bold came out as `<strong>**aa**</strong>`, which pasted back as a bold run whose
 * text was `**aa**` and saved as `****aa****` (reported), and a link came out as the characters
 * `[a](b)`, which pasted back as characters and not as a link.
 *
 * Every reveal is checked, not only the one that was reported: they are one mechanism, and the hook
 * that serves them is one hook — `transformCopied` is read through `someProp`, which stops at the
 * first plugin that has it, so a second one anywhere in the editor would be dead code.
 *
 * The payload is read off the copy event, and the round trip dispatches a paste from what was
 * captured: the real clipboard goes through the operating system and is not reliably readable from
 * a driven browser.
 */

/** Select `shown` where it stands on screen, copy, and return what went to the clipboard. */
async function copyOf(page: Page, shown: string) {
  const found = await page.evaluate((text) => {
    const walk = document.createTreeWalker(document.querySelector('.ink-doc')!, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walk.nextNode()) !== null) {
      const at = (node.textContent ?? '').indexOf(text)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + text.length)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.addEventListener('copy', (e) => {
        const data = (e as ClipboardEvent).clipboardData!
        ;(globalThis as Record<string, unknown>).__copied =
          { text: data.getData('text/plain'), html: data.getData('text/html') }
      }, { once: true })
      return true
    }
    return false
  }, shown)
  expect(found, `${shown} is not on screen`).toBe(true)
  await page.keyboard.press('ControlOrMeta+c')
  const copied = await page.evaluate(() =>
    (globalThis as Record<string, unknown>).__copied as { text: string; html: string })
  expect(copied, 'the copy never reached the clipboard').toBeTruthy()
  return copied
}

/** The caret at the end of the note, which is where a paste is dropped. */
async function caretAtEnd(page: Page) {
  await page.evaluate(() => {
    const paragraphs = document.querySelectorAll('.ink-doc p')
    const last = paragraphs[paragraphs.length - 1]
    if (last == null) throw new Error('the note has no paragraph to end in')
    const range = document.createRange()
    range.selectNodeContents(last)
    range.collapse(false)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.waitForTimeout(300)
}

async function paste(page: Page, payload: { text: string; html: string }) {
  await page.evaluate((given) => {
    const data = new DataTransfer()
    data.setData('text/plain', given.text)
    data.setData('text/html', given.html)
    // On the editable itself: the editor listens there, and an event dispatched on an ancestor
    // never passes through it.
    const editable = document.querySelector('.ink-doc [contenteditable="true"]')
      ?? document.querySelector('.ink-doc')!
    editable.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, payload)
  await page.waitForTimeout(500)
}

for (const probe of [
  { shown: '**bold text**', word: 'bold text', text: 'bold text', html: '>bold text</strong>' },
  { shown: '*italic text*', word: 'italic text', text: 'italic text', html: '>italic text</em>' },
  { shown: '~~struck out~~', word: 'struck out', text: 'struck out', html: '>struck out</del>' },
  { shown: '`inline code`', word: 'inline code', text: 'inline code', html: '>inline code</code>' },
  { shown: '[a link](linked/target.md)', word: 'a link', text: 'a link', html: 'href="linked/target.md"' },
]) {
  test(`crepe: copying ${probe.shown} carries what it renders as`, async ({ page }) => {
    await open(page, 'copy-crepe.md')
    await caretIn(page, probe.word)
    await expect(page.locator('.ink-doc')).toContainText(probe.shown)

    const copied = await copyOf(page, probe.shown)
    expect(copied.text, 'the syntax went to the clipboard as text').toBe(probe.text)
    expect(copied.html, 'the syntax went to the clipboard as markup').toContain(probe.html)
  })
}

test('crepe: copying an open picture carries the picture', async ({ page }) => {
  await open(page, 'copy-crepe.md')
  await page.locator('.ink-doc img').first().click()
  await expect(page.locator('.ink-doc')).toContainText('![a picture](assets/none.webp)')

  const copied = await copyOf(page, '![a picture](assets/none.webp)')
  expect(copied.html, 'the syntax went to the clipboard as text').toContain('none.webp')
  expect(copied.html).not.toContain('![a picture]')
})

test('crepe: a copied run and a copied link come back as themselves', async ({ page }) => {
  await open(page, 'copy-crepe.md')

  await caretIn(page, 'bold text')
  await expect(page.locator('.ink-doc')).toContainText('**bold text**')
  const bold = await copyOf(page, '**bold text**')
  await caretAtEnd(page)
  await paste(page, bold)

  await caretIn(page, 'a link')
  await expect(page.locator('.ink-doc')).toContainText('[a link](linked/target.md)')
  const link = await copyOf(page, '[a link](linked/target.md)')
  await caretAtEnd(page)
  await paste(page, link)

  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(900)
  const saved = await read(page, 'notes/copy-crepe.md')
  expect(saved, 'the asterisks came back doubled').not.toContain('****')
  expect(saved.match(/\*\*bold text\*\*/g), 'the pasted run lost its bold').toHaveLength(2)
  expect(saved.match(/\[a link\]\(linked\/target\.md\)/g), 'the pasted link came back as text')
    .toHaveLength(2)
})
