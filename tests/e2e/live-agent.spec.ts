import { expect, test, type Page } from '@playwright/test'

/**
 * The API, driven as the agent, against a real session in a real browser.
 *
 * This is the only test that proves the whole path: the owner's editor keeps the mirror, the server
 * reads it without a schema, an op parked over HTTP is applied by that editor as a local
 * transaction, and the note holds the result after the session ends. Everything else about the
 * agent API is unit tested, and none of those tests would catch the two ends disagreeing.
 */
test.setTimeout(120_000)

async function signIn(page: Page, note: string, expectText: string) {
  await page.addInitScript(() => { localStorage.setItem('inkstone.editorEngine', 'crepe') })
  await page.goto('/')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: new RegExp(`^${note.replace('.', '\\.')}$`) }).click()
  await expect(page.locator('.ink-doc')).toContainText(expectText, { timeout: 15_000 })
}

const NOTE = 'live-agent-crepe.md'

/** Start a session and come away with what an agent needs: the id and the token. */
async function asAgent(page: Page): Promise<{ id: string; token: string }> {
  const row = page.locator('.ink-tree-row').filter({ hasText: NOTE })
  await row.hover()
  await page.getByRole('button', { name: `Actions for ${NOTE}` }).click()
  await page.getByText('Live share…').click()
  await page.locator('.ink-share').getByRole('button', { name: 'Start' }).click()

  const link = page.locator('.ink-share-url .ink-share-urltext')
  await expect(link).toContainText('/live/', { timeout: 15_000 })
  const id = (await link.innerText()).trim().split('/live/')[1]!

  // Hidden until asked for: it is a credential, not a link.
  await expect(page.locator('.ink-live-token-value')).toHaveClass(/hidden/)
  await page.getByRole('button', { name: 'Show' }).click()
  const token = (await page.locator('.ink-live-token-value').innerText()).trim()
  expect(token).not.toContain('•')
  expect(token).not.toBe(id)

  await page.getByRole('button', { name: 'Close live share' }).click()
  return { id, token }
}

test('an agent reads the note, edits it, and the owner keeps the result', async ({ page, request }) => {
  await signIn(page, NOTE, 'Before.')
  const { id, token } = await asAgent(page)
  const auth = { authorization: `Bearer ${token}` }

  // Read: the mirror is there without the agent touching the editor.
  const read = await request.get(`/api/live/${id}/text`, { headers: auth })
  expect(read.ok(), await read.text()).toBe(true)
  const first = await read.json() as { text: string; version: number; applying: boolean; note: string }
  expect(first.note).toBe(`notes/${NOTE}`)
  expect(first.text).toContain('Before.')
  // Somebody is in a position to apply an edit, which is the one thing an agent cannot find out
  // for itself.
  expect(first.applying).toBe(true)

  // Edit: anchored, conditional, and visible on the owner's screen.
  const edited = await request.post(`/api/live/${id}/edit`, {
    headers: auth,
    data: { version: first.version, ops: [{ find: 'Before.', replace: 'Before. The agent was here.' }] },
  })
  expect(edited.ok(), await edited.text()).toBe(true)
  expect(await edited.json()).toMatchObject({ applied: [{ op: 0, matched: 1 }] })
  await expect(page.locator('.ink-doc')).toContainText('The agent was here.', { timeout: 15_000 })

  // And the agent is in the room, where the owner can see it.
  await expect(page.locator('.ink-live-btn')).toHaveAttribute('title', /agent/, { timeout: 15_000 })

  // Markdown, parsed the editor's way rather than inserted as characters.
  const appended = await request.post(`/api/live/${id}/edit`, {
    headers: auth,
    data: { ops: [{ append: '## From the agent\n\n- one\n- two\n' }] },
  })
  expect(appended.ok(), await appended.text()).toBe(true)
  await expect(page.locator('.ink-doc h2')).toContainText('From the agent', { timeout: 15_000 })
  await expect(page.locator('.ink-doc li')).toHaveCount(2)

  // Ending writes the agent's work into the note, with one commit for the session.
  const row = page.locator('.ink-tree-row').filter({ hasText: NOTE })
  await row.hover()
  await page.getByRole('button', { name: `Actions for ${NOTE}` }).click()
  await page.getByRole('menuitem', { name: /^Live · / }).click()
  await page.getByRole('button', { name: 'End session' }).click()
  await expect(page.locator('.ink-share')).toContainText('Session ended', { timeout: 15_000 })

  const saved = await page.evaluate(async () => {
    const res = await fetch(`/api/file?path=${encodeURIComponent('notes/live-agent-crepe.md')}`)
    return (await res.json() as { content: string }).content
  })
  expect(saved, 'the agent’s edit was not saved').toContain('The agent was here.')
  expect(saved).toContain('## From the agent')
  expect(saved).toContain('- one')
})

test('every refusal says what to do about it', async ({ page, request }) => {
  await signIn(page, NOTE, 'Before.')
  const { id, token } = await asAgent(page)
  const auth = { authorization: `Bearer ${token}` }

  const now = await (await request.get(`/api/live/${id}/text`, { headers: auth })).json() as
    { version: number }

  const stale = await request.post(`/api/live/${id}/edit`, {
    headers: auth,
    data: { version: now.version + 99, ops: [{ append: 'x' }] },
  })
  expect(stale.status()).toBe(409)
  expect(await stale.json()).toMatchObject({
    error: 'the note moved',
    hint: expect.stringContaining('re-read'),
  })

  const missing = await request.post(`/api/live/${id}/edit`, {
    headers: auth,
    data: { ops: [{ find: 'nothing like this is in the note', replace: 'x' }] },
  })
  expect(missing.status()).toBe(422)
  expect(await missing.json()).toMatchObject({ error: 'anchor not found', op: 0, matched: 0 })

  // "." is in both paragraphs of the fixture.
  const ambiguous = await request.post(`/api/live/${id}/edit`, {
    headers: auth,
    data: { ops: [{ find: '.', replace: '!' }] },
  })
  expect(ambiguous.status()).toBe(422)
  const said = await ambiguous.json() as { error: string; matched: number }
  expect(said.error).toBe('anchor is ambiguous')
  expect(said.matched).toBeGreaterThan(1)

  // The session id is not the credential.
  const wrong = await request.get(`/api/live/${id}/text`, {
    headers: { authorization: `Bearer ${id}` },
  })
  expect(wrong.status()).toBe(401)
  expect(await wrong.json()).toMatchObject({ hint: expect.stringContaining('not the session id') })

  // Nothing of any of that reached the note: four refused requests and the text is what it was.
  const after = await (await request.get(`/api/live/${id}/text`, { headers: auth })).json() as
    { text: string; version: number }
  expect(after.text).toContain('Before.')
  expect(after.text).not.toContain('!')
  expect(after.text).not.toContain('x')
  // And the version did not move either, which is what "atomic" means from outside.
  expect(after.version).toBe(now.version)

  await page.getByRole('button', { name: `Actions for ${NOTE}` }).click()
  await page.getByRole('menuitem', { name: /^Live · / }).click()
  await page.getByRole('button', { name: 'End session' }).click()
  await expect(page.locator('.ink-share')).toContainText('Session ended', { timeout: 15_000 })
})

/**
 * One edit, one application, however many people are watching.
 *
 * Reported after a real session: with a guest in the room, an agent's four ops came back `200` with
 * `matched: 1` each and the note ended up holding `Programmming` and `什么是是` — every client had
 * applied the batch, so each insertion happened once per browser while the deletions, deleting the
 * same characters, looked fine. The same cause doubled the mirror: two clients replacing the whole
 * text concurrently is two copies of it.
 *
 * So the test needs two browsers. One is not enough to see any of it.
 */
test('an edit lands once with a guest in the room, and the answer is already current', async ({ browser, request }) => {
  const owner = await browser.newContext()
  const guest = await browser.newContext()
  const mine = await owner.newPage()
  const theirs = await guest.newPage()

  try {
    await signIn(mine, NOTE, 'Before.')
    const { id, token } = await asAgent(mine)
    const auth = { authorization: `Bearer ${token}` }

    // A guest, in the room and editing, exactly as when this was reported.
    await theirs.goto(`/live/${id}`)
    await theirs.locator('#ink-live-name').fill('Guest 2')
    await theirs.getByRole('button', { name: 'Join' }).click()
    await expect(theirs.locator('.ink-doc')).toContainText('Before.', { timeout: 15_000 })
    await expect(mine.locator('.ink-live-btn')).toHaveAttribute('title', /Guest 2/, { timeout: 15_000 })

    const before = await (await request.get(`/api/live/${id}/text`, { headers: auth })).json() as
      { version: number; text: string; applying: boolean }
    expect(before.applying, 'the owner is here, so somebody can apply').toBe(true)

    // An insertion, which is the op that duplicated: a deletion would have hidden the bug.
    const res = await request.post(`/api/live/${id}/edit`, {
      headers: auth,
      data: { version: before.version, ops: [{ find: 'Before.', replace: 'Before. once upon a time.' }] },
    })
    expect(res.ok(), await res.text()).toBe(true)

    /*
     * The answer carries the edit, not the note as it was.
     *
     * Reported: "200 的响应体里 text 和 version 都是旧的". The result was written the instant the
     * transaction dispatched and the mirror followed on a debounce, so the server read the old one.
     */
    const answered = await res.json() as { text: string; version: number }
    expect(answered.text).toContain('once upon a time.')
    expect(answered.version).toBeGreaterThan(before.version)

    // Once. Not once per browser.
    expect(answered.text.match(/once upon a time\./g)).toHaveLength(1)
    await expect(mine.locator('.ink-doc')).toContainText('once upon a time.', { timeout: 15_000 })
    await expect(theirs.locator('.ink-doc')).toContainText('once upon a time.', { timeout: 15_000 })
    expect((await mine.locator('.ink-doc').innerText()).match(/once upon a time\./g)).toHaveLength(1)

    // And the note itself is not doubled: the mirror has one writer now.
    const after = await (await request.get(`/api/live/${id}/text`, { headers: auth })).json() as
      { text: string }
    expect(after.text.match(/Before\./g)).toHaveLength(1)
    expect(after.text.match(/After\./g)).toHaveLength(1)

    await mine.getByRole('button', { name: `Actions for ${NOTE}` }).click()
    await mine.getByRole('menuitem', { name: /^Live · / }).click()
    await mine.getByRole('button', { name: 'End session' }).click()
    await expect(mine.locator('.ink-share')).toContainText('Session ended', { timeout: 15_000 })

    const saved = await mine.evaluate(async () => {
      const res2 = await fetch(`/api/file?path=${encodeURIComponent('notes/live-agent-crepe.md')}`)
      return (await res2.json() as { content: string }).content
    })
    expect(saved.match(/once upon a time\./g), 'the note kept two copies').toHaveLength(1)
  } finally {
    await owner.close()
    await guest.close()
  }
})
