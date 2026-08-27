import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A file-tree row by exact name.
 *
 * Not `getByText(name)`: that matches substrings, and the tree's empty state reads
 * "No notes yet" — so `getByText('notes')` matches the empty state too and a click can
 * land on it before the tree has loaded, leaving the folder collapsed.
 */
function treeItem(page: import('@playwright/test').Page, name: string) {
  return page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${name}$`) })
}

async function login(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await expect(treeItem(page, 'notes')).toBeVisible()
}

/** Wait for the document to be present and click into it. */
async function waitForEditor(page: import('@playwright/test').Page) {
  const editable = page.locator('.ink-doc')
  await expect(editable).toBeVisible({ timeout: 15_000 })
  return editable
}

// ---------------------------------------------------------------------------
// Phase 0 tests (cache headers, login, persist)
// ---------------------------------------------------------------------------

// Guard against cache-header regression: @fastify/send's built-in
// Cache-Control (default "public, max-age=0") must not overwrite the values
// set by the setHeaders hook.  The fix is cacheControl:false in the
// fastifyStatic registration; this test verifies it at the HTTP level using a
// real built server, so it cannot pass without the header actually being sent.
test('cache-control headers: index.html no-store, hashed assets immutable', async ({ request }) => {
  // index.html must never be cached so a stale pointer to deleted hashed
  // filenames cannot cause a deploy break.
  const indexRes = await request.get('/')
  expect(indexRes.headers()['cache-control']).toContain('no-store')

  // Parse the index.html body to discover a real hashed asset URL at runtime
  // (the hash changes with every build, so we cannot hard-code the filename).
  const body = await indexRes.text()
  const assetMatch = body.match(/\/assets\/[^"' >]+\.(?:js|css)/)
  expect(assetMatch, 'index.html must reference at least one hashed asset').toBeTruthy()
  const assetUrl = assetMatch![0]

  // Hashed assets are content-addressed (Vite appends a content hash), so they
  // can be cached forever.
  const assetRes = await request.get(assetUrl)
  const assetCc = assetRes.headers()['cache-control']
  expect(assetCc).toContain('max-age=31536000')
  expect(assetCc).toContain('immutable')

  // SPA fallback for an unknown client route must also return no-store because
  // it serves index.html via reply.sendFile() through the same setHeaders hook.
  const spaRes = await request.get('/some-unknown-client-route')
  expect(spaRes.headers()['cache-control']).toContain('no-store')
})

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// Phase 0.5 removed autosave.  Saving now requires an explicit Ctrl+S.
// Migrated: was .cm-content; now uses Vditor IR editable area.
// IR mode renders markdown live — to verify content persists we use the API
// to write the file directly, then reload and assert it appears in the IR.
test('log in, open a file, edit, save with Ctrl+S, content persists after reload', async ({ page }) => {
  await login(page)

  await treeItem(page, 'notes').click()
  await treeItem(page, 'hello.md').click()

  // Wait for the editor to render the h1 from "# hello"
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })

  const editable = await waitForEditor(page)
  await editable.click()

  // Type a unique marker as a new paragraph; use Ctrl+Enter to ensure a new block
  await page.keyboard.press('End')
  await page.keyboard.type(' persistence-test')

  // The dirty dot must appear — this confirms the editor registered our input
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toBeVisible({ timeout: 10_000 })

  // Manual save (autosave was removed in Phase 0.5)
  await page.keyboard.press('ControlOrMeta+s')
  // Wait for dirty dot to disappear as the save-complete signal
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0, { timeout: 10_000 })

  await page.reload()
  await treeItem(page, 'notes').click()
  await treeItem(page, 'hello.md').click()

  // After reload, wait for the editor to render then assert the typed text persists
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.ink-doc')).toContainText('persistence-test', { timeout: 15_000 })
})

test('stays on the login page when the password is wrong', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('wrong')
  await page.getByRole('button', { name: 'Enter' }).click()
  await expect(page.getByText('Wrong password')).toBeVisible()
})

// ---------------------------------------------------------------------------
// Phase 0.5 tests: file-tree CRUD and manual-save dot
// ---------------------------------------------------------------------------

test('file tree: create → rename → delete', async ({ page }) => {
  await login(page)

  // Scope to the file tree to avoid matching the breadcrumb or editor
  const fileTree = page.locator('[role="tree"]')

  // Create at the root through the sidebar header's + menu
  // exact: the empty editor also has "New note" and "New folder", which a substring match hits.
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New file' }).click()
  // Use CSS class to avoid ambiguity with the editor's own role=textbox
  const treeInput = page.locator('.ink-tree-inline-input')
  await treeInput.fill('e2e-new.md')
  await treeInput.press('Enter')
  await expect(fileTree.getByText('e2e-new.md')).toBeVisible()

  // Rename: hover the row to reveal actions, then click rename
  await fileTree.getByText('e2e-new.md').hover()
  await page.getByRole('button', { name: 'Actions for e2e-new.md' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const renameInput = page.locator('.ink-tree-inline-input')
  await renameInput.fill('e2e-renamed.md')
  await renameInput.press('Enter')
  await expect(fileTree.getByText('e2e-renamed.md')).toBeVisible()

  // Delete: hover the row to reveal actions, then click delete and confirm
  await fileTree.getByText('e2e-renamed.md').hover()
  await page.getByRole('button', { name: 'Actions for e2e-renamed.md' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByTitle('Confirm delete').click()
  await expect(fileTree.getByText('e2e-renamed.md')).toHaveCount(0)
})

// Migrated: was .cm-content; now uses Vditor IR editable area.
test('manual save: dot appears on edit and disappears on Ctrl+S', async ({ page }) => {
  await login(page)

  // Open the seeded welcome.md inside the notes folder
  await treeItem(page, 'notes').click()
  await treeItem(page, 'welcome.md').click()

  // Wait for the editor to initialise
  const editable = await waitForEditor(page)

  // Click into the editable area and type something to mark the document dirty
  await editable.click()
  await page.keyboard.type('edit')

  // Unsaved dot must appear in the breadcrumb
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toBeVisible()

  // Ctrl+S triggers manual save
  await page.keyboard.press('ControlOrMeta+s')

  // Dot must disappear once saved
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Phase 1 tests: Lapis IR render, theme toggle, no external CDN
// ---------------------------------------------------------------------------

test('the editor renders Lapis: blue h1 heading + blue-background h2 pill', async ({ page }) => {
  await login(page)

  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()

  // The editor renders real h1 and h2 elements from the markdown
  const h1 = page.locator('.ink-doc h1').first()
  const h2 = page.locator('.ink-doc h2').first()

  await expect(h1).toBeVisible({ timeout: 15_000 })
  await expect(h2).toBeVisible({ timeout: 15_000 })

  // h1 color should be the Lapis accent (#4870ac = rgb(72, 112, 172))
  const h1color = await h1.evaluate((el) => getComputedStyle(el).color)
  expect(h1color).toBe('rgb(72, 112, 172)')

  // h2 pill: white text on Lapis accent background (#4870ac = rgb(72, 112, 172))
  const h2bg = await h2.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(h2bg).toBe('rgb(72, 112, 172)')
})

test('manual save: editing rich.md shows a dot, Ctrl+S clears it', async ({ page }) => {
  await login(page)

  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()

  const editable = await waitForEditor(page)
  await editable.click()
  await page.keyboard.type('edit')

  // Unsaved dot must appear in the breadcrumb
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toBeVisible()

  // Ctrl+S triggers manual save
  await page.keyboard.press('ControlOrMeta+s')

  // Dot must disappear once saved
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)
})
test('read-only still allows copying a code block and following a link', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()

  const block = page.locator('.ink-doc .milkdown-code-block').first()
  await expect(block).toBeVisible({ timeout: 15_000 })

  await page.locator('.ink-topbar .ink-viewbtn[title^="Read"]').click()
  await expect(page.locator('.ink-topbar .ink-viewbtn[title^="Read"]')).toHaveAttribute('aria-pressed', 'true')

  await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'))
  await block.hover()
  await block.locator('.copy-button').first().click({ force: true })
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('const x = 1')

  // A link is an `<a>`, and a plain click follows it while reading — the modifier is for editing.
  const opened = context.waitForEvent('page')
  await page.locator('.ink-doc a[href*="example.com"]').first().click({ force: true })
  expect((await opened).url()).toContain('example.com')
})

// Borrowed from VSCode's welcome screen: a faint wordmark over rows of name-and-keys, no buttons.
// Before there is a history there is no Recent group at all — a heading over an empty list is worse
// than no list — but Start is always there, because the actions do not depend on having one.
test('the empty editor offers the actions first, then recent notes once there are any', async ({ page }) => {
  await login(page)

  const empty = page.locator('.ink-empty')
  await expect(empty).toBeVisible()
  await expect(empty.locator('.ink-empty-mark')).toHaveText('Inkstone')
  await expect(empty.locator('.ink-empty-eyebrow')).toHaveText(['Start'])
  await expect(empty.locator('.ink-empty-action')).toHaveCount(2)

  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })
  await expect(empty).toHaveCount(0)

  // Reopening with nothing selected shows what was just read, and it opens again from there.
  await page.reload()
  await expect(empty.locator('.ink-empty-eyebrow')).toHaveText(['Recent', 'Start'])
  const first = empty.locator('.ink-empty-item').first()
  await expect(first.locator('.ink-empty-name')).toHaveText('rich.md')
  await expect(first.locator('.ink-empty-where')).toHaveText('notes')
  await first.click()
  await expect(page.locator('.ink-breadcrumb')).toContainText('rich.md')
  await expect(empty).toHaveCount(0)
})

// The name is typed into an inline input in the file tree, which is unmounted while the sidebar
// is collapsed — so the button has to bring the sidebar back or it does nothing at all.
test('New note works from the empty editor with the sidebar collapsed', async ({ page }) => {
  await login(page)
  await expect(page.locator('.ink-empty-action').first()).toBeVisible()

  await expect.poll(async () => {
    if (await page.locator('.ink-left').count()) await page.keyboard.press('ControlOrMeta+\\')
    return page.locator('.ink-left').count()
  }).toBe(0)

  await page.getByRole('button', { name: /New note/ }).click()
  await expect(page.locator('.ink-tree-inline-input')).toBeVisible()
})

// The keycaps on those rows are a promise. Cmd+N and Shift+Cmd+N are the conventional keys and the
// browser keeps both, so these are on Alt — matched by `e.code`, since holding Option on macOS
// rewrites `e.key` to a composed character.
test('the keys the empty editor advertises actually create things', async ({ page }) => {
  await login(page)

  await page.keyboard.press('ControlOrMeta+Alt+KeyN')
  await expect(page.locator('.ink-tree-inline-input')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.ink-tree-inline-input')).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+Alt+KeyF')
  await expect(page.locator('.ink-tree-inline-input')).toBeVisible()
  await page.keyboard.press('Escape')

  // From the outline the tree is unmounted, so the shortcut has to bring it back or do nothing.
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.locator('.ink-tree-container')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Alt+KeyN')
  await expect(page.locator('.ink-tree-inline-input')).toBeVisible()
  await page.keyboard.press('Escape')

  // Ctrl/Cmd+Alt+<digit> sets a heading level and must still reach the editor untouched.
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await waitForEditor(page)
  await page.getByText('Text below the code block.').click()
  await page.keyboard.press('ControlOrMeta+Alt+3')
  await expect(page.locator('.ink-doc h3')).toHaveCount(1)
})

// Autocommit runs every five minutes, so a row per commit reports the timer rather than the work.
// The panel groups a run of autosaves into one session, and never merges a deliberate commit into
// the ones around it — pressing Commit is the only real signal in a log of generated messages.
test('the right panel groups history into sessions and can restore a version', async ({ page }) => {
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })

  await page.keyboard.press('ControlOrMeta+/')
  const panel = page.locator('.ink-hist')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.ink-hist-facts dt').first()).toHaveText('Modified')

  // The fixture vault has one commit, so there is exactly one entry and it is the creation.
  const entries = panel.locator('.ink-hist-entry')
  await expect(entries).toHaveCount(1)
  await expect(entries.first()).toContainText('Created')

  // Expanding fetches the diff for that range and shows it in one step: an earlier version put a
  // "loading" line up first and replaced it ~20ms later, which read as the panel stuttering twice.
  await entries.first().click()
  await expect(panel.locator('.ink-hist-diff')).toBeVisible()
  await expect(panel.locator('.ink-hist-diff')).toContainText('Heading level 1')
  // Raw hunk headers are coordinates into a file nobody is counting lines in.
  await expect(panel.locator('.ink-hist-diff')).not.toContainText('@@')

  // Restoring loads the old text into the editor as unsaved changes and writes nothing.
  await page.locator('.ink-doc').click()
  await page.keyboard.type('scribble')
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toBeVisible()
  await panel.locator('.ink-hist-restore').click()
  await expect(page.locator('.ink-doc')).not.toContainText('scribble')
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toBeVisible()

  const onDisk = await page.evaluate(async () =>
    (await (await fetch('/api/file?path=notes/rich.md')).json()).content as string)
  expect(onDisk).not.toContain('scribble')
})

// A note git has never seen has no history to show, and saying so beats an empty list.
test('the right panel says so for a note that was never committed', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New file' }).click()
  await page.locator('.ink-tree-inline-input').fill('untracked.md')
  await page.keyboard.press('Enter')
  await expect(page.locator('.ink-breadcrumb')).toContainText('untracked.md')

  await page.keyboard.press('ControlOrMeta+/')
  await expect(page.locator('.ink-hist')).toContainText('never been committed')
})

// saveError was set on every failed write and read by nothing, so a save that failed looked
// exactly like one that worked. The only thing that stopped the work being lost was the unsaved
// dot staying on, and nothing said why pressing Ctrl+S again kept doing nothing.
test('a save that fails says so, and does not pretend the file was written', async ({ page }) => {
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })

  await page.route('**/api/file', (route) => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk is full' }) })
    : route.continue())

  await page.locator('.ink-doc').click()
  await page.keyboard.type(' edited')
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+s')

  await expect(page.locator('.ink-conflict')).toContainText('disk is full')
  // Still unsaved, and still saying so.
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toBeVisible()

  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.locator('.ink-conflict')).toHaveCount(0)
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toBeVisible()
})

// Whether to show the login form was decided once at startup, so a session that ended mid-edit
// left a live-looking app whose every action failed with nothing on screen about it.
test('a session that ends mid-edit returns to the login form', async ({ page, context }) => {
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })

  await page.locator('.ink-doc').click()
  await page.keyboard.type(' edited')
  await context.clearCookies()
  await page.keyboard.press('ControlOrMeta+s')

  await expect(page.locator('input[type=password]')).toBeVisible()
})

// A document theme owns the shell as well as the page: the two share one surface, so switching
// the theme repaints the sidebar too rather than leaving two shades meeting at the pane border.
test('switching the document theme repaints the document and the shell, and it sticks', async ({ page }) => {
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })

  // Vditor rebuilds its DOM when a theme is applied, so read the state only once the surface is
  // back — otherwise the probe can land inside that window and find nothing.
  const state = async () => {
    await page.waitForFunction(() => !!document.querySelector('.ink-doc h2'))
    return page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-doc-theme'),
      docFont: getComputedStyle(document.querySelector('.ink-doc')!).fontFamily.split(',')[0],
      // Lapis renders h2 as a filled pill; Plain does not use colour for structure at all.
      h2Bg: getComputedStyle(document.querySelector('.ink-doc h2')!).backgroundColor,
      shellBg: getComputedStyle(document.querySelector('.ink-left')!).backgroundColor,
      docBg: getComputedStyle(document.querySelector('.ink-doc')!).backgroundColor,
    }))
  }

  const lapis = await state()
  expect(lapis.theme).toBe('lapis')
  expect(lapis.h2Bg).not.toBe('rgba(0, 0, 0, 0)')

  await page.locator('button[title="Settings"]').click()
  await page.locator('.ink-swatch[data-doc-theme-preview="plain"]').click()

  const plain = await state()
  expect(plain.theme).toBe('plain')
  expect(plain.docFont).not.toBe(lapis.docFont)
  expect(plain.h2Bg).toBe('rgba(0, 0, 0, 0)')

  // Dark: the shell must land on the same colour as the page, not near it.
  await page.locator('.ink-settings-row').filter({ hasText: 'Appearance' })
    .getByRole('button', { name: 'Dark', exact: true }).click()
  const dark = await state()
  expect(dark.docBg).toBe(dark.shellBg)
  expect(dark.docBg).not.toBe(plain.docBg)

  // Reloading lands on the empty editor — no document, so read the choice off the root rather
  // than out of a page that is not there.
  await page.reload()
  await expect(page.locator('.ink-shell')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-doc-theme'))).toBe('plain')
})

// The fenced-block plumbing is shared by every theme, not owned by one. It lived inside
// lapis-theme.css until a second theme existed, and Plain inherited none of it: the blank line
// above every code block came back, 26px of it, with the collapsed source still inline-block.
test('code blocks behave the same under every document theme', async ({ page }) => {
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })

  const measure = () => page.evaluate(() => {
    const node = document.querySelector('.milkdown-code-block')!
    const code = node.querySelector('.cm-content')!
    const body = getComputedStyle(document.querySelector('.ink-doc')!)
    return {
      theme: document.documentElement.getAttribute('data-doc-theme'),
      slackAbovePre: Math.round(code.getBoundingClientRect().top - node.getBoundingClientRect().top),
      blockFill: getComputedStyle(node).backgroundColor,
      // The setting names the body size; a theme may not quietly scale it.
      bodyPx: body.fontSize,
      labelColor: getComputedStyle(node, '::after').color,
      bodyColor: body.color,
    }
  })

  // aspartate is a converted Typora theme and a dark-only one: it must clear the same bar.
  // Every theme, converted or hand-written, clears the same bar.
  for (const themeId of ['lapis', 'plain', 'aspartate', 'forest', 'tailwind', 'everforest', 'bitclean']) {
    if (themeId !== 'lapis') {
      await page.locator('button[title="Settings"]').click()
      await page.locator(`.ink-swatch[data-doc-theme-preview="${themeId}"]`).click()
      await page.keyboard.press('Escape')
      await page.waitForFunction((id) => document.documentElement.getAttribute('data-doc-theme') === id, themeId)
    }
    const m = await measure()
    expect(m.theme, themeId).toBe(themeId)
    // The block has a surface of its own under every theme — the plumbing is shared and no theme
    // owns it. It lived inside `lapis-theme.css` until a second theme existed, and Plain inherited
    // none of it: the fill went, and the code sat on the page.
    expect(m.blockFill, themeId).not.toBe('rgba(0, 0, 0, 0)')
    // How much room the code is given inside that surface is the theme's business, and they differ
    // on purpose — 16px in Lapis, 2rem in BitClean. That it is given *some* is not.
    expect(m.slackAbovePre, themeId).toBeGreaterThan(0)
    // The setting names the body size; a theme may not quietly scale it.
    expect(m.bodyPx, themeId).toBe('16px')
  }
})

// Every colour token changes at once when the appearance flips, and anything with a transition
// animates through the change — the selected file row swept from #e9ebef to #2f3542 over 120ms,
// which reads as a pale flash across a dark sidebar.
test('switching appearance does not animate the theme change', async ({ page }) => {
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })

  await page.locator('button[title="Settings"]').click()
  await page.getByRole('button', { name: 'Light', exact: true }).click()

  const seen = await page.evaluate(async () => {
    const row = document.querySelector('.ink-tree-row.selected')!
    const colours = [getComputedStyle(row).backgroundColor]
    let running = true
    const sample = () => {
      if (!running) return
      colours.push(getComputedStyle(row).backgroundColor)
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    const dark = Array.from(document.querySelectorAll('.ink-theme-btn'))
      .find((b) => b.textContent?.trim() === 'Dark') as HTMLButtonElement
    dark.click()
    await new Promise((r) => setTimeout(r, 500))
    running = false
    return [...new Set(colours)]
  })

  // Exactly two: the value before and the value after. Anything between them is the animation.
  expect(seen).toHaveLength(2)
})

// A document theme may colour the chrome only through the --ink-* tokens. Everforest carried
// `button:not(#write *)` — upstream's way of saying "every button OUTSIDE the document", i.e.
// Typora's own chrome — and painted every button in the app with !important, border included.
// The converter had read the document root inside the :not() as proof the rule was already scoped.
test('no document theme paints the application directly', async ({ page }) => {
  await login(page)
  await page.locator('button[title="Settings"]').click()

  for (const themeId of ['lapis', 'plain', 'aspartate', 'forest', 'tailwind', 'everforest', 'bitclean']) {
    await page.locator(`.ink-swatch[data-doc-theme-preview="${themeId}"]`).click()
    await page.waitForFunction((id) => document.documentElement.getAttribute('data-doc-theme') === id, themeId)

    const btn = await page.locator('.ink-theme-btn').first().evaluate((el) => {
      const cs = getComputedStyle(el)
      const root = getComputedStyle(document.documentElement)
      return {
        border: cs.borderTopWidth,
        // Chrome colour is allowed to change, but only by following the token.
        followsToken: cs.backgroundColor === root.getPropertyValue('--ink-sidebar-active').trim()
          || cs.backgroundColor === 'rgba(0, 0, 0, 0)',
        token: root.getPropertyValue('--ink-sidebar-active').trim(),
      }
    })
    expect(btn.border, themeId).toBe('0px')
    expect(btn.token, themeId).not.toBe('')
  }
})

// A dialog whose only exits are the backdrop and Escape strands anyone whose dialog covers the
// backdrop, which is every phone. The close button is shown at every size for that reason.
test('settings closes from its own button, and offers 12px', async ({ page }) => {
  await login(page)
  await page.locator('button[title="Settings"]').click()
  await expect(page.locator('.ink-settings')).toBeVisible()

  const sizes = await page.locator('#ink-editor-font-select option').allTextContents()
  expect(sizes).toEqual(['12', '14', '16', '18'])

  await page.selectOption('#ink-editor-font-select', '12')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement)
    .getPropertyValue('--ink-font-size').trim())).toBe('12px')

  await page.locator('[aria-label="Close settings"]').click()
  await expect(page.locator('.ink-settings')).toHaveCount(0)
})

// Keyboard focus was invisible everywhere: no `:focus` or `:focus-visible` rule existed, so
// tabbing through the shell moved a caret nobody could see. Asserted by pressing Tab rather than
// calling focus() — scripted focus does not match :focus-visible, which is what made an earlier
// measurement of this read as a much bigger problem than it was.
test('keyboard focus is visible', async ({ page }) => {
  await login(page)
  await page.evaluate(() => { document.body.focus() })

  const seen: boolean[] = []
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    const ring = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      // The element itself, or the box around it. A composite widget legitimately shows focus on
      // its wrapper — the search field does, because a ring standing outside an input that already
      // sits in a bordered box draws a second rectangle around the first.
      const shows = (node: Element | null) => {
        if (!node) return false
        const cs = getComputedStyle(node)
        return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none'
      }
      return shows(el) || shows(el.parentElement)
    })
    if (ring !== null) seen.push(ring)
  }
  expect(seen.length).toBeGreaterThan(4)
  expect(seen.every(Boolean), 'every keyboard-focusable control must show it').toBe(true)
})

// A long path wrapped to a second line inside a 48px bar rather than truncating: a flex item will
// not shrink below its content without `min-width: 0`, so the ellipsis never applied.
test('a long path truncates rather than wrapping the top bar', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 700 })
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await waitForEditor(page)

  const bar = await page.evaluate(() => {
    const el = document.querySelector('.ink-breadcrumb')!
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20
    return { lines: Math.round(el.getBoundingClientRect().height / lh) }
  })
  expect(bar.lines).toBe(1)
})

test('a fenced block keeps its distance from the text below it', async ({ page }) => {
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()

  const node = page.locator('.ink-doc .milkdown-code-block').first()
  await expect(node).toBeVisible({ timeout: 15_000 })

  const gaps = await node.evaluate((el) => {
    const r = (n: Element) => n.getBoundingClientRect()
    const prev = el.previousElementSibling
    const next = el.nextElementSibling
    return {
      above: prev ? Math.round(r(el).top - r(prev).bottom) : null,
      below: next ? Math.round(r(next).top - r(el).bottom) : null,
    }
  })
  expect(gaps.below).toBeGreaterThan(0)
  expect(gaps.below).toBe(gaps.above)
})
test('read-only mode leaves the rendering untouched when clicked', async ({ page }) => {
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()

  const toggle = page.locator('.ink-topbar .ink-viewbtn[title^="Read"]')
  const link = page.locator('.ink-doc a[href]').first()
  await expect(link).toBeVisible({ timeout: 15_000 })

  // Editing: a caret in a link shows its markdown. This is what read-only has to suppress.
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await link.click({ force: true })
  await expect(page.locator('.ink-doc')).toContainText('](')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  // Entering read-only closes whatever was already open rather than stranding it.
  await expect(page.locator('.ink-doc')).not.toContainText('](')

  await page.locator('.ink-doc h1').first().click({ force: true })
  await expect(page.locator('.ink-doc')).not.toContainText('](')

  // Typing cannot reach the document either, so nothing is ever marked unsaved.
  const before = await page.locator('.ink-doc').textContent()
  await page.keyboard.type('XXXX')
  await expect(page.locator('.ink-doc')).toHaveText(before ?? '')
  await expect(page.locator('.ink-breadcrumb .ink-unsaved-dot')).toHaveCount(0)

  // Selecting and copying must still work — read-only is for reading.
  const para = page.locator('.ink-doc p').first()
  const box = await para.boundingBox()
  if (box) {
    await page.mouse.move(box.x + 4, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()
    expect((await page.evaluate(() => getSelection()?.toString() ?? '')).length).toBeGreaterThan(0)
  }

  // Cmd/Ctrl+E is the same switch, and editing works again afterwards.
  await page.keyboard.press('ControlOrMeta+e')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.ink-doc a[href]').first()).toBeVisible()
  await page.locator('.ink-doc a[href]').first().click()
  await expect(page.locator('.ink-doc')).toContainText('](')
})

test('editor scrolls at the window edge, and the measure starts one gutter in', async ({ page }) => {
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })

  const geo = await page.evaluate(() => {
    const scroller = document.querySelector('.ink-doc')!
    const style = getComputedStyle(scroller)
    const measure = getComputedStyle(document.documentElement).getPropertyValue('--ink-content-width')
    const box = scroller.getBoundingClientRect()
    return {
      scrollerRight: Math.round(box.right),
      viewport: window.innerWidth,
      padLeft: Number.parseFloat(style.paddingLeft),
      // A top-level paragraph, which is where a line actually wraps. Not a heading: the themes
      // hang its markers in the gutter, so it is wider than the measure by design.
      text: Math.round(document.querySelector('.ink-doc > p')!.getBoundingClientRect().width),
      measure: Number.parseFloat(measure),
    }
  })

  // The scroll container reaches the window edge, so its scrollbar is painted there rather
  // than stranded mid-screen.
  expect(geo.scrollerRight).toBe(geo.viewport)
  // The left edge is the gutter and nothing else — the one position that does not depend on what
  // else is open.
  expect(geo.padLeft).toBe(56)
  // And the measure is the measure, on a window with room for it.
  expect(geo.text).toBe(geo.measure)
})

test('no external CDN requests (all assets self-hosted)', async ({ page }) => {
  const external: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') external.push(r.url())
  })

  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()

  // Wait for the editor to fully initialise and render h1 (signals all assets loaded)
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })
  // Extra settle time to catch any deferred/lazy asset requests
  await page.waitForTimeout(1500)

  expect(external, `External requests detected: ${external.join(', ')}`).toEqual([])
})

// The GitHub route ships now — the server says which sign-in it has and the browser renders it.
// What must never ship is the development door, which reads a token out of localStorage. That is
// a claim about the build, so it is checked against the build rather than trusted.
test('the built bundle contains no development token door', () => {
  const assets = path.join(process.cwd(), 'dist/web/assets')
  const bundles = fs.readdirSync(assets).filter((f) => f.endsWith('.js'))
  expect(bundles.length).toBeGreaterThan(0)

  const offenders: string[] = []
  for (const file of bundles) {
    const text = fs.readFileSync(path.join(assets, file), 'utf8')
    for (const needle of ['inkstone.dev.github']) {
      if (text.includes(needle)) offenders.push(`${file}: ${needle}`)
    }
  }
  expect(offenders, `Dev-only code shipped: ${offenders.join(', ')}`).toEqual([])
})

test('theme switch: after switching to dark, data-theme=dark and h1 color is the dark Lapis accent', async ({ page }) => {
  await login(page)

  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()

  // Wait for the editor to render
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })

  // Open settings modal via the gear button
  await page.getByTitle('Settings').click()

  // Wait for settings modal to appear
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()

  // Click "Dark" theme button
  await page.getByRole('button', { name: 'Dark', exact: true }).click()

  // Close settings (click backdrop or Escape)
  await page.keyboard.press('Escape')

  // Verify data-theme attribute on <html> is "dark"
  const dataTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  expect(dataTheme).toBe('dark')

  // In dark mode, Lapis dark accent for h1 is #8393ad = rgb(131, 147, 173)
  // (h1 inherits color from --lapis-accent which is overridden to #8393ad in dark mode)
  const h1color = await page.locator('.ink-doc h1').first().evaluate((el) => getComputedStyle(el).color)
  expect(h1color).toBe('rgb(131, 147, 173)')
})

// ---------------------------------------------------------------------------
// Outline panel and the restructured sidebar
// ---------------------------------------------------------------------------

// Jump and active tracking are pure geometry. jsdom reports every rect as zero, so a jsdom
// test of them would assert nothing while appearing to pass — they are e2e-only.
test('outline: lists headings, jumps to one, and tracks the active heading', async ({ page }) => {
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Outline' }).click()
  const rows = page.locator('.ink-outline-row')
  await expect(rows.first()).toBeVisible()
  expect(await rows.count()).toBeGreaterThan(1)

  const scrollTopOf = () => page.evaluate(
    () => document.querySelector('.ink-doc')!.scrollTop,
  )
  const before = await scrollTopOf()
  await rows.nth(1).click()
  await page.waitForTimeout(300)
  expect(await scrollTopOf()).not.toBe(before)

  // After jumping to the second heading, that row becomes the active one.
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
})

test('sidebar: Cmd+1 / Cmd+2 switch views', async ({ page }) => {
  await login(page)
  await expect(page.locator('.ink-tree-container')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.locator('.ink-outline, .ink-outline-empty')).toBeVisible()
  await expect(page.locator('.ink-tree-container')).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.locator('.ink-tree-container')).toBeVisible()
})

test('layout: sidebar runs full height, status bar starts at its right edge', async ({ page }) => {
  await login(page)
  const geo = await page.evaluate(() => {
    const left = document.querySelector('.ink-left')!.getBoundingClientRect()
    const status = document.querySelector('.ink-statusbar')!.getBoundingClientRect()
    return {
      leftBottom: Math.round(left.bottom),
      leftRight: Math.round(left.right),
      statusLeft: Math.round(status.left),
      statusBottom: Math.round(status.bottom),
      statusTop: Math.round(status.top),
      viewportHeight: window.innerHeight,
      gitInStatusBar: document.querySelector('.ink-statusbar .ink-git-footer') !== null,
      gitInSidebar: document.querySelector('.ink-left .ink-git-footer') !== null,
    }
  })
  expect(geo.leftBottom).toBe(geo.viewportHeight)
  expect(geo.statusBottom).toBe(geo.viewportHeight)
  expect(geo.statusLeft).toBe(geo.leftRight)
  // git is pinned to the status bar, never hosted by the sidebar.
  expect(geo.gitInStatusBar).toBe(true)
  expect(geo.gitInSidebar).toBe(false)
})

// The top bar must span both grid columns. Without `grid-column: 1 / -1` it auto-places
// into column 1 — the sidebar's track — and its right-hand icons bunch up beside the
// breadcrumb, which only shows when the sidebar is open.
test('layout: the top bar spans the full width in both sidebar states', async ({ page }) => {
  await login(page)
  // With no file open the counts and the view group are gone by design, so this needs a document.
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await waitForEditor(page)
  const read = () => page.evaluate(() => {
    const tb = document.querySelector('.ink-topbar')!.getBoundingClientRect()
    const countsEl = document.querySelector('.ink-statusbar-counts')!
    const counts = countsEl.getBoundingClientRect()
    const buttons = Array.from(document.querySelectorAll('.ink-topbar button'))
    return {
      topbarWidth: Math.round(tb.width),
      viewport: window.innerWidth,
      lastIconRight: Math.round(buttons[buttons.length - 1]!.getBoundingClientRect().right),
      countsLeft: Math.round(counts.left),
      countsText: countsEl.textContent,
    }
  })

  // The counts are an inline-flex box sized by their own content, so a word count still settling
  // moves the left edge for a reason that has nothing to do with the sidebar. Wait for two
  // readings in a row to agree before measuring anything against them. This failed once in a full
  // parallel run and passed three times alone; comparing the strings was not enough, because then
  // it was the string comparison that failed instead.
  //
  // Two readings agreeing is not by itself enough, either: `0 words 0 chars` is what the counts say
  // before the document has been counted at all, and it is perfectly stable while that lasts. This
  // note is not empty, so the count that matters is the one after it stops being zero.
  await expect.poll(async () => (await read()).countsText).not.toMatch(/^0 words/)
  await expect.poll(async () => (await read()).countsText).toBe((await read()).countsText)

  const open = await read()
  expect(open.topbarWidth).toBe(open.viewport)
  // The trailing icons sit against the right edge, not next to the breadcrumb.
  expect(open.viewport - open.lastIconRight).toBeLessThan(40)

  await page.keyboard.press('ControlOrMeta+\\')
  const collapsed = await read()
  expect(collapsed.topbarWidth).toBe(collapsed.viewport)
  expect(collapsed.viewport - collapsed.lastIconRight).toBeLessThan(40)
  // The counts keep their position when the sidebar collapses.
  //
  // Guarded on the text, because this failed once under a full parallel run and passed three times
  // alone: the counts are an inline-flex box sized by its own content, so a word count still
  // settling between the two reads moves the left edge 11px for a reason that has nothing to do
  // with the sidebar. Comparing positions across two different strings measures the string.
  expect(collapsed.countsText).toBe(open.countsText)
  expect(collapsed.countsLeft).toBe(open.countsLeft)
})

// The git controls moved into the sidebar footer, and the sidebar unmounts when collapsed.
// Without a fallback, Cmd+\ would silently take away the branch, dirty dot, commit and push.
test('git controls stay pinned bottom-right in both sidebar states', async ({ page }) => {
  await login(page)
  const pos = () => page.evaluate(() => {
    const g = document.querySelector('.ink-statusbar .ink-git-footer')!.getBoundingClientRect()
    return { right: Math.round(g.right), viewport: window.innerWidth, count: document.querySelectorAll('.ink-git-footer').length }
  })

  const open = await pos()
  expect(open.count).toBe(1)
  expect(open.viewport - open.right).toBeLessThan(40)

  await expect.poll(async () => {
    if (await page.locator('.ink-left').count()) await page.keyboard.press('ControlOrMeta+\\')
    return page.locator('.ink-left').count()
  }).toBe(0)
  const collapsed = await pos()
  // Same single instance, same place — collapsing must not move or remove it.
  expect(collapsed.count).toBe(1)
  expect(collapsed.right).toBe(open.right)
  await expect(page.getByRole('button', { name: 'Commit' })).toBeVisible()
})

/*
 * The drawer takes room from the margin, and from the text only when the margin has run out.
 *
 * The left edge of the text is fixed — it is the one position that does not depend on what else is
 * open — so a panel appearing beside the words never moves them. On a window with room to spare
 * nothing changes at all; on a narrow one the right edge comes in and the column compresses, and
 * gets its full measure back the moment the drawer closes.
 */
test('the drawer takes the margin before it takes the text', async ({ page }) => {
  await login(page)
  await treeItem(page, 'notes').click()
  await treeItem(page, 'rich.md').click()
  await expect(page.locator('.ink-doc h1')).toBeVisible({ timeout: 15_000 })

  const measure = () => page.evaluate(() => {
    // A top-level paragraph. Not a heading — the themes hang its markers in the gutter, so it is
    // wider than the measure by design — and not the first `p` in the note either, which is inside
    // the blockquote and indented.
    const p = document.querySelector('.ink-doc > p')!.getBoundingClientRect()
    const right = document.querySelector('.ink-right')
    const scroller = document.querySelector('.ink-doc')!.getBoundingClientRect()
    return {
      textLeft: Math.round(p.left),
      width: Math.round(p.width),
      drawerOpen: right !== null,
      scrollerRight: Math.round(scroller.right),
      viewport: window.innerWidth,
    }
  })

  // Wide: the drawer is free. 1660px of room, less 750 of text and a 56px gutter, leaves more than
  // the drawer needs — so not a pixel of the note moves or changes.
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.waitForTimeout(200)
  const wideShut = await measure()
  await page.keyboard.press('ControlOrMeta+/')
  await page.waitForTimeout(400)
  const wideOpen = await measure()

  expect(wideOpen.drawerOpen).toBe(true)
  expect(wideOpen.textLeft).toBe(wideShut.textLeft)
  expect(wideOpen.width).toBe(wideShut.width)
  expect(wideShut.width).toBe(750)

  // Narrow: it is not. The left edge holds and the column gives up what the drawer needs.
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.waitForTimeout(400)
  const narrowOpen = await measure()
  expect(narrowOpen.textLeft).toBe(wideShut.textLeft)
  expect(narrowOpen.width).toBeLessThan(750)

  // And it comes back.
  await page.keyboard.press('ControlOrMeta+/')
  await page.waitForTimeout(400)
  const narrowShut = await measure()
  expect(narrowShut.drawerOpen).toBe(false)
  expect(narrowShut.width).toBe(750)
  expect(narrowShut.textLeft).toBe(wideShut.textLeft)

  // The scroll container still reaches the window edge, so the scrollbar stays there.
  expect(narrowShut.scrollerRight).toBe(narrowShut.viewport)
  expect(wideOpen.scrollerRight).toBe(wideOpen.viewport)
})

// The row menu is fixed-positioned so it escapes the sidebar's overflow clipping; if that
// regressed it would be cut off at the row instead of overlaying the editor.
test('row menu opens fully outside the sidebar and closes on Escape', async ({ page }) => {
  await login(page)
  await treeItem(page, 'notes').hover()
  await page.getByRole('button', { name: 'Actions for notes' }).click()

  const menu = page.locator('.ink-menu')
  await expect(menu).toBeVisible()
  const geo = await page.evaluate(() => {
    const m = document.querySelector('.ink-menu')!.getBoundingClientRect()
    const side = document.querySelector('.ink-left')!.getBoundingClientRect()
    return { menuBottom: Math.round(m.bottom), menuHeight: Math.round(m.height), sideRight: Math.round(side.right), menuRight: Math.round(m.right) }
  })
  // Not clipped: it has real height and is fully inside the viewport.
  expect(geo.menuHeight).toBeGreaterThan(60)
  expect(geo.menuBottom).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight))

  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})
