import { expect, test, type Page } from '@playwright/test'

const file = 'notes/mark-toggle.md'
const original = 'Before **boldword** and *italicword* and ~~strikeword~~ and `codeword` after.\n'
const formats = [
  { name: 'bold', selector: 'strong', word: 'boldword', syntax: '**', shortcut: 'ControlOrMeta+b', button: 'Bold' },
  { name: 'italic', selector: 'em', word: 'italicword', syntax: '*', shortcut: 'ControlOrMeta+i', button: 'Italic' },
  { name: 'strikethrough', selector: 'del', word: 'strikeword', syntax: '~~', shortcut: 'ControlOrMeta+Alt+x', button: 'Strikethrough' },
  { name: 'inline code', selector: 'code', word: 'codeword', syntax: '`', shortcut: null, button: 'Inline code' },
] as const

async function select(page: Page, text: string, collapse = false, backward = false) {
  await page.evaluate(({ text, collapse, backward }) => {
    const doc = document.querySelector('.ink-doc')!
    ;(doc.closest('.ProseMirror') as HTMLElement | null)?.focus()
    const nodes = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT)
    const parts: { node: Node; start: number; end: number }[] = []
    let plain = ''
    for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
      const start = plain.length
      plain += node.textContent ?? ''
      parts.push({ node, start, end: plain.length })
    }
    const at = plain.indexOf(text)
    if (at < 0) throw new Error(`Text not found: ${text}`)
    const start = at + (collapse ? 1 : 0)
    const end = at + (collapse ? 1 : text.length)
    const first = parts.find((part) => start >= part.start && start <= part.end)!
    const last = parts.find((part) => end >= part.start && end <= part.end)!
    const range = document.createRange()
    range.setStart(first.node, start - first.start)
    range.setEnd(last.node, end - last.start)
    const selection = getSelection()!
    selection.removeAllRanges()
    if (backward && !collapse) selection.setBaseAndExtent(last.node, end - last.start, first.node, start - first.start)
    else selection.addRange(range)
  }, { text, collapse, backward })
  await page.waitForTimeout(100)
}

async function expectSaved(page: Page, expected: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/file?path=${encodeURIComponent(file)}`)
    return (await response.json()).content
  }).toBe(expected)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter', exact: true }).click()
  await page.request.post('/api/file', { data: { path: file, kind: 'file' } })
  await page.request.put('/api/file', { data: { path: file, content: original } })
  await page.reload()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^mark-toggle\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('boldword')
})

test.afterEach(async ({ page }) => { await page.request.delete(`/api/file?path=${encodeURIComponent(file)}`) })

for (const format of formats) {
  for (const gesture of format.shortcut ? ['shortcut', 'toolbar'] : ['toolbar']) {
    test(`${format.name}: ${gesture} reveals newly applied formatting and retains the text selection`, async ({ page }) => {
      await select(page, 'Before')
      if (gesture === 'shortcut' && format.shortcut) await page.keyboard.press(format.shortcut)
      else await page.getByRole('button', { name: format.button, exact: true }).click()
      await expect(page.locator('.ink-doc p')).toContainText(`${format.syntax}Before${format.syntax}`)
      expect(await page.evaluate(() => getSelection()?.toString())).toBe('Before')
      await page.keyboard.press('ControlOrMeta+s')
      await expectSaved(page, original.replace('Before', `${format.syntax}Before${format.syntax}`))
    })
  }

  test(`${format.name}: undo, redo and a second toggle keep newly revealed syntax in sync`, async ({ page }) => {
    await select(page, 'Before')
    if (format.shortcut) await page.keyboard.press(format.shortcut)
    else await page.getByRole('button', { name: format.button, exact: true }).click()
    await expect(page.locator('.ink-doc p')).toContainText(`${format.syntax}Before${format.syntax}`)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator(`.ink-doc ${format.selector}`).filter({ hasText: 'Before' })).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(page.locator(`.ink-doc ${format.selector}`).filter({ hasText: 'Before' })).toHaveCount(1)
    await expect(page.locator('.ink-doc p')).not.toContainText(`${format.syntax}Before${format.syntax}`)
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('Before')
    if (format.shortcut) await page.keyboard.press(format.shortcut)
    else await page.getByRole('button', { name: format.button, exact: true }).click()
    await expect(page.locator('.ink-doc p')).not.toContainText(`${format.syntax}Before${format.syntax}`)
    await page.keyboard.press('ControlOrMeta+s')
    await expectSaved(page, original)
  })

  for (const gesture of format.shortcut ? ['shortcut', 'toolbar'] : ['toolbar']) {
    test(`${format.name}: ${gesture} removes revealed syntax and stays removed after save/reopen`, async ({ page }) => {
      await page.locator(`.ink-doc ${format.selector}`).filter({ hasText: new RegExp(`^${format.word}$`) }).click()
      await expect(page.locator('.ink-doc')).toContainText(`${format.syntax}${format.word}${format.syntax}`)
      await select(page, format.word)
      if (gesture === 'shortcut' && format.shortcut) await page.keyboard.press(format.shortcut)
      else await page.getByRole('button', { name: format.button, exact: true }).click()
      await expect(page.locator('.ink-doc p')).not.toContainText(`${format.syntax}${format.word}${format.syntax}`)
      await select(page, 'Before', true)
      await select(page, format.word, true)
      await expect(page.locator(`.ink-doc ${format.selector}`).filter({ hasText: format.word })).toHaveCount(0)
      await page.keyboard.press('ControlOrMeta+s')
      const expected = original.replace(`${format.syntax}${format.word}${format.syntax}`, format.word)
      await expectSaved(page, expected)
      // Let both editor listener/debounce queues settle before checking a reopened draft.
      await page.waitForTimeout(450)
      await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
      await page.reload()
      await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
      await page.locator('.ink-tree-name').filter({ hasText: /^mark-toggle\.md$/ }).click()
      await expect(page.locator('.ink-doc')).toContainText(format.word)
      await expect(page.locator(`.ink-doc ${format.selector}`).filter({ hasText: format.word })).toHaveCount(0)
    })
  }
}

test('removing part of bold text preserves the formatting outside the selection', async ({ page }) => {
  await page.locator('.ink-doc strong').click()
  await select(page, 'ldwo')
  await page.keyboard.press('ControlOrMeta+b')
  await select(page, 'Before', true)
  await page.keyboard.press('ControlOrMeta+s')
  await expectSaved(page, original.replace('**boldword**', '**bo**ldwo**rd**'))
})

test('applying bold preserves a backwards selection without selecting its markers', async ({ page }) => {
  await select(page, 'Before', false, true)
  await page.keyboard.press('ControlOrMeta+b')
  await expect(page.locator('.ink-doc p')).toContainText('**Before**')
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('Before')
  expect(await page.evaluate(() => {
    const selection = getSelection()!
    const range = document.createRange()
    range.setStart(selection.anchorNode!, selection.anchorOffset)
    range.setEnd(selection.focusNode!, selection.focusOffset)
    return range.collapsed
  })).toBe(true)
})

test('applying bold to an expanded italic run reveals bold and keeps italic formatting', async ({ page }) => {
  await page.locator('.ink-doc em').click()
  await expect(page.locator('.ink-doc')).toContainText('*italicword*')
  await select(page, 'italicword')
  await page.keyboard.press('ControlOrMeta+b')
  await expect(page.locator('.ink-doc p')).toContainText('**italicword**')
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('italicword')
  await page.keyboard.press('ControlOrMeta+s')
  await expectSaved(page, original.replace('*italicword*', '***italicword***'))
})

test('pressing bold twice on the same selection leaves no delimiters', async ({ page }) => {
  await select(page, 'Before')
  await page.keyboard.press('ControlOrMeta+b')
  await expect(page.locator('.ink-doc p')).toContainText('**Before**')
  await page.keyboard.press('ControlOrMeta+b')
  await expect(page.locator('.ink-doc p')).not.toContainText('**Before**')
  await page.keyboard.press('ControlOrMeta+s')
  await expectSaved(page, original)
})

test('typing after applying bold can be undone and redone without duplicating syntax', async ({ page }) => {
  await select(page, 'Before')
  await page.keyboard.press('ControlOrMeta+b')
  await expect(page.locator('.ink-doc p')).toContainText('**Before**')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('x')
  await expect(page.locator('.ink-doc p')).toContainText('Beforex')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.ink-doc p')).not.toContainText('Beforex')
  await expect(page.locator('.ink-doc strong').filter({ hasText: 'Before' })).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(page.locator('.ink-doc strong').filter({ hasText: 'Beforex' })).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+s')
  await expectSaved(page, original.replace('Before', '**Beforex**'))
})

test('undoing a word typed between manual markers preserves the typed markers', async ({ page }) => {
  await page.locator('.ink-doc p').last().evaluate((paragraph) => {
    ;(paragraph.closest('.ProseMirror') as HTMLElement).focus()
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(false)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.waitForTimeout(100)
  await page.keyboard.press('Enter')
  await page.keyboard.type('****')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('typed')
  await expect(page.locator('.ink-doc p').last()).toHaveText('**typed**')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.ink-doc p').last()).toHaveText('****')
})

for (const format of formats) {
  test(`${format.name}: undo and redo do not restore literal reveal markers`, async ({ page }) => {
    await page.locator(`.ink-doc ${format.selector}`).filter({ hasText: format.word }).click()
    await select(page, format.word)
    if (format.shortcut) await page.keyboard.press(format.shortcut)
    else await page.getByRole('button', { name: format.button, exact: true }).click()
    await expect(page.locator('.ink-doc p')).not.toContainText(`${format.syntax}${format.word}${format.syntax}`)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator(`.ink-doc ${format.selector}`).filter({ hasText: format.word })).toHaveCount(1)
    await expect(page.locator('.ink-doc p')).not.toContainText(format.syntax.repeat(4))
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(page.locator(`.ink-doc ${format.selector}`).filter({ hasText: format.word })).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+s')
    await expectSaved(page, original.replace(`${format.syntax}${format.word}${format.syntax}`, format.word))
  })
}

test('a selection including the revealed asterisks removes only the intended formatting', async ({ page }) => {
  await page.locator('.ink-doc strong').click()
  await expect(page.locator('.ink-doc')).toContainText('**boldword**')
  await select(page, '**boldword**')
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.press('ControlOrMeta+s')
  await expectSaved(page, original.replace('**boldword**', 'boldword'))
})

for (const target of ['outer bold', 'inner italic'] as const) {
  test(`nested formatting: removing ${target} preserves the other mark`, async ({ page }) => {
    await page.request.put('/api/file', { data: { path: file, content: 'Before **outer *middle* tail** after.\n' } })
    await page.reload()
    await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
    await page.locator('.ink-tree-name').filter({ hasText: /^mark-toggle\.md$/ }).click()
    await expect(page.locator('.ink-doc')).toContainText('outer')
    await page.locator('.ink-doc em').click()
    if (target === 'outer bold') {
      await select(page, 'outer', true)
      await expect(page.locator('.ink-doc')).toContainText('**outer middle tail**')
      await select(page, 'outer middle tail')
      await page.keyboard.press('ControlOrMeta+b')
    } else {
      await expect(page.locator('.ink-doc')).toContainText('*middle*')
      await select(page, 'middle')
      await page.keyboard.press('ControlOrMeta+i')
    }
    await page.keyboard.press('ControlOrMeta+s')
    await expectSaved(page, target === 'outer bold'
      ? 'Before outer *middle* tail after.\n' : 'Before **outer middle tail** after.\n')
  })
}
