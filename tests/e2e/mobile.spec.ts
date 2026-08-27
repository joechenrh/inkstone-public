import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * The phone.
 *
 * Measured before this existed, on a 390px screen: the sidebar took 260px of it, and the content
 * column's own gutter formula — which reserves half the leftover width plus the right drawer's
 * 320px — then resolved to 56px left and 376px right inside the 130px that remained. The text was
 * laid out at **zero width**, one character per line.
 *
 * Tapping into the document and typing already worked once given room, so none of this is a second
 * application: the same components and the same state, with one screen at a time below 720px.
 */

// An iPhone 13's viewport and touch, on the Chromium the rest of the suite runs on — spreading
// `devices['iPhone 13']` would switch the browser to WebKit, which is not installed here. What is
// being tested is the layout and the touch affordances, and both are the app's rather than the
// engine's; a real Safari check is still worth doing by hand.
test.use({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true })

async function login(page: Page) {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await expect(page.locator('.ink-shell--phone')).toBeVisible({ timeout: 15_000 })
}

test('the list and the document are two screens, and back keeps the file open', async ({ page }) => {
  await login(page)
  // The list is the screen, not a 260px column beside one.
  await expect(page.locator('.ink-left')).toBeVisible()
  await expect(page.locator('.ink-center')).toHaveCount(0)
  await expect(page.locator('.ink-breadcrumb')).toHaveText('Notes')

  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).tap()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).tap()
  await expect(page.locator('.ink-center')).toBeVisible()
  await expect(page.locator('.ink-left')).toHaveCount(0)
  await expect(page.locator('.ink-breadcrumb')).toContainText('rich.md')

  await page.locator('[title="Back to the list"]').tap()
  await expect(page.locator('.ink-left')).toBeVisible()
  // Back is navigation, not closing: returning costs no reload and loses no draft.
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).tap()
  await expect(page.locator('.ink-breadcrumb')).toContainText('rich.md')
})

test('the document gets the width of the screen', async ({ page }) => {
  await login(page)
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).tap()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).tap()
  await expect(page.locator('.ink-doc')).toBeVisible({ timeout: 15_000 })

  // After the screen transition, not during it: the document is visible a frame before it has
  // finished sliding in, and measured there it is 292px of a 390px screen.
  await page.waitForTimeout(1500)
  const measured = await page.evaluate(() => {
    const el = document.querySelector('.ink-doc')!
    const cs = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
      text: Math.round(rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      overflows: document.documentElement.scrollWidth > window.innerWidth,
    }
  })
  // Was 0 before the phone layout existed.
  expect(measured.text).toBeGreaterThan(300)
  expect(measured.overflows).toBe(false)
})

test('a note opens in read, and editing is one tap away', async ({ page }) => {
  await login(page)
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).tap()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).tap()
  await expect(page.locator('.ink-doc')).toBeVisible({ timeout: 15_000 })

  const lit = () => page.evaluate(() => document
    .querySelector('.ink-phonebar .ink-viewbtn[aria-pressed="true"]')?.getAttribute('title'))
  expect(await lit()).toBe('Read')

  await page.locator('.ink-phonebar').getByTitle('Edit', { exact: true }).tap()
  expect(await lit()).toBe('Edit')
})

test('the bottom bar carries Save, and reports whether there is anything to save', async ({ page }) => {
  await login(page)
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).tap()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).tap()
  await expect(page.locator('.ink-doc')).toBeVisible({ timeout: 15_000 })

  // There is no Ctrl+S on a phone, so the button is the only route to disk.
  const save = page.locator('.ink-phonebar-save')
  await expect(save).toHaveText('Saved')
  await expect(save).toBeDisabled()

  await page.locator('.ink-phonebar').getByTitle('Source', { exact: true }).tap()
  await page.locator('.ink-source-area').tap()
  await page.keyboard.type('typed on a phone')
  await expect(save).toHaveText('Save')
  await save.tap()
  await expect(save).toHaveText('Saved')
})

test('no keycaps and no undersized targets on a touch screen', async ({ page }) => {
  await login(page)
  // A chip reading ⌘⌥N on a device with no ⌘ names a key that does not exist.
  await expect(page.locator('.ink-empty-where kbd')).toBeHidden()

  const small = await page.evaluate(() => Array.from(
    document.querySelectorAll<HTMLElement>('.ink-iconbtn'))
    .filter((b) => b.offsetParent !== null)
    .filter((b) => b.getBoundingClientRect().height < 44)
    .map((b) => b.title || b.getAttribute('aria-label') || '?'))
  expect(small, 'every tap target must reach 44px').toEqual([])
})

// The outline is a sidebar tab, which on a phone lives on the *other screen*: reaching it while
// reading cost back, switch tab, tap a heading, and being pushed back into the note. As a sheet it
// is two taps and no screen change, in the pattern History and Settings already use here.
test('the outline is a sheet over the note, not a trip to the other screen', async ({ page }) => {
  await login(page)
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).tap()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).tap()
  await expect(page.locator('.ink-doc')).toBeVisible({ timeout: 15_000 })

  await page.locator('[aria-label="More"]').tap()
  await page.getByRole('menuitem', { name: 'Outline' }).tap()
  await expect(page.locator('.ink-sheet')).toBeVisible()
  // The note stays on screen behind it — that is what says this is over the document.
  await expect(page.locator('.ink-doc')).toBeVisible()

  const scrolled = () => page.evaluate(() =>
    Math.round(document.querySelector('.ink-doc')!.scrollTop))
  const before = await scrolled()

  // Picking a heading is the only reason to open this, so it closes on the way.
  await page.locator('.ink-sheet button').filter({ hasText: 'Heading level 2' }).first().tap()
  await expect(page.locator('.ink-sheet')).toHaveCount(0)
  await expect.poll(scrolled).toBeGreaterThan(before)
})

// As a drawer, History replaced the note with no scrim and no close, and the back arrow goes to
// the list rather than out of history — so the only way back was the menu that opened it. A screen
// you can only leave through the menu that opened it is a bug, not a design choice.
test('History is a sheet with a way out', async ({ page }) => {
  await login(page)
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).tap()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).tap()
  await expect(page.locator('.ink-doc')).toBeVisible({ timeout: 15_000 })

  await page.locator('[aria-label="More"]').tap()
  await page.getByRole('menuitem', { name: 'History' }).tap()
  await expect(page.locator('.ink-sheet-title')).toHaveText('History')
  // The note stays behind it, and there are two ways out that are not the menu.
  await expect(page.locator('.ink-doc')).toBeVisible()
  await expect(page.locator('[aria-label="Close history"]')).toBeVisible()

  await page.locator('.ink-sheet-scrim').tap({ position: { x: 195, y: 40 } })
  await expect(page.locator('.ink-sheet')).toHaveCount(0)
})

// Save was a 36px outlined pill beside a 48px tray — two kinds of control in one bar, and under
// the 44px floor this app holds every other touch target to.
// The sheet was sized by its content, so history — which fetches its log on mount — opened at half
// height and then expanded. A detent that does not depend on what is inside it cannot do that.
test('the sheet opens at one height, whatever it is loading', async ({ page }) => {
  await login(page)
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).tap()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).tap()
  await expect(page.locator('.ink-doc')).toBeVisible({ timeout: 15_000 })

  await page.evaluate(() => {
    ;(window as unknown as { hs: number[] }).hs = []
    new MutationObserver(() => {
      const el = document.querySelector('.ink-sheet')
      if (el) (window as unknown as { hs: number[] }).hs.push(Math.round(el.getBoundingClientRect().height))
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  await page.locator('[aria-label="More"]').tap()
  await page.getByRole('menuitem', { name: 'History' }).tap()
  await expect(page.locator('.ink-sheet')).toBeVisible()
  await page.waitForTimeout(800)

  const heights = await page.evaluate(() => [...new Set((window as unknown as { hs: number[] }).hs)])
  expect(heights.length, `sheet was seen at ${heights.join(', ')}px`).toBe(1)

  // The note's time and size are the title's subtitle, not a second block above the log.
  await expect(page.locator('.ink-sheet-sub')).toBeVisible()
  await expect(page.locator('.ink-sheet .ink-hist-facts')).toBeHidden()
})

// There is no status bar on a phone — the desktop's git footer, which carries the error line, is
// not rendered here — so a push said nothing at all, success or failure.
test('git actions say what happened, and a failure waits to be read', async ({ page }) => {
  await page.route('**/api/git/status', async (r) => {
    await r.fulfill({ json: { dirty: false, branch: 'main', hasRemote: true, ahead: 4 } })
  })
  let fail = false
  await page.route('**/api/git/push', async (r) => {
    if (fail) await r.fulfill({ status: 500, json: { error: 'no upstream branch' } })
    else await r.fulfill({ json: { pushed: 4 } })
  })
  await login(page)
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).tap()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).tap()
  await expect(page.locator('.ink-phonebar')).toBeVisible({ timeout: 15_000 })

  await page.locator('[aria-label="More"]').tap()
  await page.getByRole('menuitem', { name: /^Push/ }).tap()
  await expect(page.locator('.ink-gitnotice')).toContainText('Pushed 4 to main')
  // Success clears itself; there is nothing to come back to.
  await expect(page.locator('.ink-gitnotice')).toHaveCount(0, { timeout: 6000 })

  fail = true
  await page.locator('[aria-label="More"]').tap()
  await page.getByRole('menuitem', { name: /^Push/ }).tap()
  const notice = page.locator('.ink-gitnotice.error')
  await expect(notice).toContainText('no upstream branch')
  // A failure is the one you might need to read twice, so it stays until dismissed.
  await page.waitForTimeout(4000)
  await expect(notice).toBeVisible()
  await page.locator('[aria-label="Dismiss"]').tap()
  await expect(page.locator('.ink-gitnotice')).toHaveCount(0)
})

test('the bottom bar is two controls of the same kind', async ({ page }) => {
  await login(page)
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).tap()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).tap()
  await expect(page.locator('.ink-phonebar')).toBeVisible({ timeout: 15_000 })

  const bar = await page.evaluate(() => {
    const save = document.querySelector('.ink-phonebar-save')!.getBoundingClientRect()
    const group = document.querySelector('.ink-viewgroup')!.getBoundingClientRect()
    return { save: Math.round(save.height), group: Math.round(group.height) }
  })
  expect(bar.save).toBe(bar.group)
  expect(bar.save).toBeGreaterThanOrEqual(44)
})

test('the sheet is modal and the scrim dismisses it', async ({ page }) => {
  await login(page)
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).tap()
  await page.locator('.ink-tree-name').filter({ hasText: /^rich\.md$/ }).tap()
  await expect(page.locator('.ink-doc')).toBeVisible({ timeout: 15_000 })

  await page.locator('[aria-label="More"]').tap()
  await page.getByRole('menuitem', { name: 'Outline' }).tap()
  await expect(page.locator('.ink-sheet')).toBeVisible()

  // The bar behind it is covered, which is what a modal sheet is for.
  const covering = await page.evaluate(() => {
    const back = document.querySelector('[title="Back to the list"]')!.getBoundingClientRect()
    return document.elementFromPoint(back.x + back.width / 2, back.y + back.height / 2)?.className
  })
  expect(covering).toBe('ink-sheet-scrim')

  await page.locator('.ink-sheet-scrim').tap({ position: { x: 195, y: 60 } })
  await expect(page.locator('.ink-sheet')).toHaveCount(0)
})

test('settings fits the screen and can be left', async ({ page }) => {
  await login(page)
  await page.locator('[aria-label="More"]').tap()
  await page.getByRole('menuitem', { name: 'Settings' }).tap()

  const fits = await page.evaluate(() => {
    const el = document.querySelector('.ink-settings')!.getBoundingClientRect()
    return el.width <= window.innerWidth && el.bottom <= window.innerHeight + 1
  })
  // 749px tall inside a 664px viewport before this, with its buttons unreachable.
  expect(fits).toBe(true)

  // The dialog is the screen here, so there is no backdrop left to tap and no Escape key to
  // press: without a visible close it was a room with no door.
  const close = page.locator('[aria-label="Close settings"]')
  await expect(close).toBeVisible()
  const box = (await close.boundingBox())!
  expect(Math.round(box.height)).toBeGreaterThanOrEqual(44)
  await close.tap()
  await expect(page.locator('.ink-settings')).toHaveCount(0)
})
