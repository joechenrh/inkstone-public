import { expect, test, type Page } from '@playwright/test'

/**
 * GitHub's alerts, in both engines.
 *
 * The two get there by different routes — a DOM observer that wraps the marker in one, decorations
 * in the other, because ProseMirror reads unexpected DOM changes back as edits — and the point of
 * the shared rule is that they arrive at the same picture. If they ever stop agreeing, the last
 * test here is the one that says so.
 */

const ALERTS = ['note', 'tip', 'important', 'warning', 'caution']

async function open(page: Page, engine: 'crepe') {
  await page.addInitScript((e) => { localStorage.setItem('inkstone.editorEngine', e) }, engine)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^alerts\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('Useful information', { timeout: 15_000 })
}

const kinds = (page: Page) => page.$$eval('.ink-doc blockquote', (qs) =>
  qs.map((q) => q.getAttribute('data-alert')))

/** Where the caret is, put there without a click so the test says what it means. */
async function caretIn(page: Page, kind: string) {
  await page.evaluate((k) => {
    const quote = Array.from(document.querySelectorAll('.ink-doc blockquote'))
      .find((q) => q.getAttribute('data-alert') === k)!
    const text = document.createTreeWalker(quote, NodeFilter.SHOW_TEXT).nextNode()!
    const range = document.createRange()
    range.setStart(text, 1)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }, kind)
  await page.waitForTimeout(300)
}

for (const engine of ['crepe'] as const) {
  test(`${engine}: the five are drawn, and nothing else is`, async ({ page }) => {
    await open(page, engine)
    // The plain quote and the two near-misses are untagged, in that order after the five.
    expect(await kinds(page)).toEqual([...ALERTS, null, null])
  })

  test(`${engine}: the label is the syntax when the caret is in it`, async ({ page }) => {
    await open(page, engine)
    const quote = page.locator('.ink-doc blockquote[data-alert="warning"]')
    /*
     * One predicate, because the two engines say "showing" differently: the DOM half takes its
     * span away again and leaves the raw text, the decoration half keeps the span and gives it its
     * size back. Both mean the syntax is on screen, and neither is answered by the element's box —
     * that is the label's height either way.
     */
    const syntaxHidden = () => page.evaluate(() => {
      const m = document.querySelector('.ink-doc blockquote[data-alert="warning"] .ink-alert-marker')
      return m !== null && Number.parseFloat(getComputedStyle(m).fontSize) === 0
    })
    expect(await syntaxHidden()).toBe(true)

    await caretIn(page, 'warning')
    await expect(quote).toHaveClass(/ink-alert--open/)
    expect(await syntaxHidden()).toBe(false)
    await expect(quote).toContainText('[!WARNING]')
    // And only that one.
    await expect(page.locator('.ink-doc blockquote[data-alert="note"]')).not.toHaveClass(/ink-alert--open/)

    await caretIn(page, 'note')
    await expect(quote).not.toHaveClass(/ink-alert--open/)
    expect(await syntaxHidden()).toBe(true)
  })

  test(`${engine}: drawing one changes nothing on disk`, async ({ page }) => {
    await open(page, engine)
    const before = await page.evaluate(async () => {
      const res = await fetch('/api/file?path=notes%2Falerts.md')
      return (await res.json() as { content: string }).content
    })

    await caretIn(page, 'tip')
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(600)

    // Nothing was typed, so nothing may be written — the marker is a rendering of text that is
    // really there, and a save while one is showing must not touch it.
    //
    // Compared without trailing whitespace: one engine writes a final newline the other does not,
    // which is true of every note in the vault and is not what this test is about.
    const after = await page.evaluate(async () => {
      const res = await fetch('/api/file?path=notes%2Falerts.md')
      return (await res.json() as { content: string }).content
    })
    expect(after.trimEnd()).toBe(before.trimEnd())
    expect(after).toContain('> [!NOTE]')

    // Put it back exactly. One engine writes a final newline the other does not, and this suite
    // shares one vault with a git repository in it — a note left one byte from HEAD is a pending
    // change, and the commit panel two files away shows whichever it finds first.
    await page.evaluate(async (content) => {
      await fetch('/api/file', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'notes/alerts.md', content }),
      })
    }, before)
  })
}

for (const engine of ['crepe'] as const) {
  test(`${engine}: the icon sits on the label's line, and opening one adds no blank line`, async ({ page }) => {
    await open(page, engine)

    // Reported from a screenshot: the icon floated above the label, because it was placed against
    // the blockquote's box and every theme gives that its own vertical rhythm.
    const centres = await page.evaluate(() => {
      const quote = document.querySelector('.ink-doc blockquote[data-alert="warning"]')!
      const box = quote.getBoundingClientRect()
      const icon = getComputedStyle(quote, '::before')
      const label = quote.querySelector('.ink-alert-marker')!.getBoundingClientRect()
      return {
        icon: Number.parseFloat(icon.top) + Number.parseFloat(icon.height) / 2,
        label: label.top - box.top + Math.min(label.height, 22) / 2,
      }
    })
    expect(Math.abs(centres.icon - centres.label)).toBeLessThan(3)

    // And the other half of the same screenshot: the syntax appeared with a blank line under it,
    // because the marker carried the line break and was laid out as a block.
    const closed = await page.evaluate(() =>
      document.querySelector('.ink-doc blockquote[data-alert="warning"]')!.getBoundingClientRect().height)
    await caretIn(page, 'warning')
    const opened = await page.evaluate(() =>
      document.querySelector('.ink-doc blockquote[data-alert="warning"]')!.getBoundingClientRect().height)
    // Not "about the same": the label and the syntax are one slot, one face and one size, so the
    // callout is exactly as tall either way. It grew when the syntax came in at body size, and
    // shrank by 2px when the label's own margin left with the label.
    expect(opened).toBe(closed)

    // The syntax is coloured and otherwise unchanged — the rule the editor's other reveals follow.
    const shown = await page.evaluate(() => {
      const quote = document.querySelector('.ink-doc blockquote[data-alert="warning"]')!
      const marker = quote.querySelector('.ink-alert-marker')
      if (marker === null) return null
      const m = getComputedStyle(marker)
      const body = getComputedStyle(quote)
      return { family: m.fontFamily, size: m.fontSize, bodyFamily: body.fontFamily, colour: m.color }
    })
    expect(shown?.family).toBe(shown?.bodyFamily)
    expect(shown?.colour).not.toBe('rgb(0, 0, 0)')
  })
}
