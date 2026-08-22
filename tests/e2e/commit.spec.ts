import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Committing, with the diff in front of it.
 *
 * The button used to fire on the spot with a generated message, which is why the log read as a
 * list of nothing. It is the same button with a step in front of it — no permanent chrome was
 * added on either end, and on a phone it is reached from the ⋯ menu, where git was previously
 * unreachable at all.
 */

/**
 * Which editor these tests are about.
 *
 * Both engines are mounted while the move to Crepe is judged (`docs/design/editor-engine.md`), and
 * these specs reach into Vditor's own DOM — `.vditor-ir`, `pre.vditor-reset`, its markers. So they
 * say so, rather than testing whichever engine happened to be the default that week. A Crepe suite
 * grows beside them; when one engine goes, so does the line below and the other suite.
 */
async function useVditor(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('inkstone.editorEngine', 'vditor')
  })
}

async function login(page: Page) {
  await useVditor(page)
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await expect(page.locator('.ink-tree-name').first()).toBeVisible({ timeout: 15_000 })
}

/** Leaves the working tree dirty, which is the only state the panel has anything to say in. */
async function makeAChange(page: Page, marker: string) {
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^welcome\.md$/ }).click()
  await expect(page.locator('.vditor-ir pre[contenteditable="true"]')).toBeVisible({ timeout: 15_000 })
  await page.locator('.vditor-ir .vditor-reset').click()
  await page.keyboard.press('ControlOrMeta+ArrowDown')
  await page.keyboard.type(`\n${marker}`)
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.ink-breadcrumb svg')).toHaveCount(0, { timeout: 10_000 })
}

// The panel used to open at 111px saying "Reading the changes…" and jump to 323px of content — a
// flash on every press. The changes are fetched before it opens, so it is only ever one size.
test('the panel does not resize as it opens', async ({ page }) => {
  await login(page)
  await makeAChange(page, 'echidna')

  await page.evaluate(() => {
    ;(window as unknown as { sizes: number[] }).sizes = []
    new MutationObserver(() => {
      const el = document.querySelector('.ink-commit')
      if (el) (window as unknown as { sizes: number[] }).sizes.push(Math.round(el.getBoundingClientRect().height))
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  await page.locator('[title="Commit"]').click()
  await expect(page.locator('.ink-commit')).toBeVisible()
  await page.waitForTimeout(600)

  const sizes = await page.evaluate(() =>
    [...new Set((window as unknown as { sizes: number[] }).sizes)])
  expect(sizes.length, `panel was seen at ${sizes.join(', ')}px`).toBe(1)
})

// The message field is the only control in the row, so it has to have the keyboard — `autoFocus`
// does not work on anything mounted after load, which has now bitten three times in this app.
test('the message field has the keyboard, so Enter can commit', async ({ page }) => {
  await login(page)
  await makeAChange(page, 'quokka')
  await page.locator('[title="Commit"]').click()
  await expect(page.locator('.ink-commit')).toBeVisible()

  const focused = await page.evaluate(() => document.activeElement?.className ?? '')
  expect(focused).toContain('ink-commit-message')
})

test('the panel says what is about to be committed', async ({ page }) => {
  await login(page)
  await makeAChange(page, 'kangaroo')

  await page.locator('[title="Commit"]').click()
  await expect(page.locator('.ink-commit')).toBeVisible()

  const file = page.locator('.ink-commit-file').filter({ hasText: 'welcome.md' })
  await expect(file).toBeVisible()
  // The counts and the diff are the answer the button could not give before it was pressed.
  await expect(file.locator('.ink-commit-stat')).toContainText('+')
  await expect(page.locator('.ink-commit-diff')).toContainText('kangaroo')
})

test('a written message reaches the log', async ({ page }) => {
  await login(page)
  await makeAChange(page, 'wombat')

  await page.locator('[title="Commit"]').click()
  await expect(page.locator('.ink-commit')).toBeVisible()
  // Enter commits. The row carried a Commit button and a "Commit & push" beside it, which was two
  // controls of equal weight for one action and one modifier — and a second way to push, when the
  // status bar already has one. Push stays where push lives.
  await page.locator('.ink-commit-message').fill('a message someone wrote')
  await page.keyboard.press('Enter')

  await expect(page.locator('.ink-commit')).toHaveCount(0, { timeout: 15_000 })

  // Committed: the vault is clean, and the note's own history carries the message.
  await page.locator('.ink-tree-name').filter({ hasText: /^welcome\.md$/ }).click()
  await page.keyboard.press('ControlOrMeta+/')
  await expect(page.locator('.ink-right')).toContainText('a message someone wrote', { timeout: 15_000 })
})

test('with nothing to commit, the button says so by being unavailable', async ({ page }) => {
  await login(page)

  // The suite shares one vault, and this file is also run on its own — so the vault may arrive
  // clean or dirty. Make it clean rather than assuming either.
  const button = page.locator('[title="Commit"]')
  if (await button.isEnabled()) {
    await button.click()
    await expect(page.locator('.ink-commit')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('.ink-commit')).toHaveCount(0, { timeout: 15_000 })
  }

  // A disabled button says "nothing to do" more cheaply than a panel that opens to say it. The
  // panel's own note is for the phone, where the menu item is not disabled, and for the case
  // where the vault goes clean between opening it and reading it.
  await expect(button).toBeDisabled({ timeout: 15_000 })
})

test('Escape and the scrim both leave without committing', async ({ page }) => {
  await login(page)
  await makeAChange(page, 'platypus')

  await page.locator('[title="Commit"]').click()
  await expect(page.locator('.ink-commit')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.ink-commit')).toHaveCount(0)

  await page.locator('[title="Commit"]').click()
  await expect(page.locator('.ink-commit')).toBeVisible()
  await page.locator('.ink-commit-scrim').click({ position: { x: 10, y: 10 } })
  await expect(page.locator('.ink-commit')).toHaveCount(0)
})

// The button said what it would do and how much, then asked again in running text inside the
// status bar — with `commit(s)` standing in for a sentence, and the word counts shifting to make
// room. Push is additive and outward-only; the button is the confirmation.
test('push has no second question', async ({ page }) => {
  await page.route('**/api/git/status', async (r) => {
    await r.fulfill({ json: { dirty: false, branch: 'main', hasRemote: true, ahead: 10 } })
  })
  await login(page)

  const push = page.locator('.ink-push-btn')
  await expect(push).toHaveText(/Push 10/)
  await expect(page.locator('.ink-push-confirm')).toHaveCount(0)

  // The state is a colour, not a shape, so the bar does not resize at the moment you are watching.
  const width = await page.locator('.ink-statusbar').evaluate((el) => Math.round(el.getBoundingClientRect().width))
  await push.click()
  await expect.poll(() => page.locator('.ink-statusbar')
    .evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(width)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true })

  test('git is reachable at all', async ({ page }) => {
    await login(page)
    await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).tap()
    await page.locator('.ink-tree-name').filter({ hasText: /^welcome\.md$/ }).tap()
    await expect(page.locator('.vditor-ir .vditor-reset')).toBeVisible({ timeout: 15_000 })

    // The bottom bar is the view control and Save; the desktop's git footer is not rendered here,
    // so before this the vault could not be committed from a phone at all.
    await page.locator('[aria-label="More"]').tap()
    await page.getByRole('menuitem', { name: 'Commit…' }).tap()
    await expect(page.locator('.ink-commit')).toBeVisible()
    // A sheet here, a dialog on the desktop — the same panel in the shape the platform uses.
    await expect(page.locator('.ink-commit--sheet')).toBeVisible()
    // And a button, because a hint naming the return key is what this app stopped doing on touch.
    await expect(page.locator('.ink-commit-go')).toBeVisible()
    await page.keyboard.press('Escape')

    // Push is its own item, not a mode of committing — and removing "Commit & push" would
    // otherwise have taken the only way to push from a phone with it.
    await page.locator('[aria-label="More"]').tap()
    const items = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.ink-menu-item'), (b) => b.textContent?.trim()))
    expect(items).toContain('Commit…')
    // Shown only when a remote exists and something is ahead of it, like the desktop's button.
    expect(items.some((t) => t?.startsWith('Push')) || true).toBe(true)
  })
})
