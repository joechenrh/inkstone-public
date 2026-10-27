import { expect, test } from '@playwright/test'

/**
 * The agent's instructions are reachable from the application's own origin.
 *
 * An agent is handed a session link and a token and nothing else, so the one host it can always
 * reach is the one those came from. `curl https://<host>/SKILLS.md` has to be the whole of "how do
 * I use this" — no repository to find, no account to have.
 *
 * Asserted against the running server rather than the file, because what matters is that the path
 * is served at all: it is emitted by a build step, and the SPA's catch-all would answer it with
 * `index.html` if that step ever stopped running.
 */
test('the skill is served, needs no account, and is the skill', async ({ request }) => {
  const res = await request.get('/SKILLS.md')
  expect(res.status(), 'the path fell through to the single-page app').toBe(200)

  const text = await res.text()
  expect(text, 'this is the app shell, not the skill').not.toContain('<!doctype html>')
  expect(text).toContain('name: inkstone-live-doc')
  // The four things it has to teach, each of which was a reported failure or a stated rule.
  expect(text).toContain('/api/live/')
  expect(text).toContain('anchor is ambiguous')
  expect(text).toContain('Never send the whole document')
  expect(text).toContain('You cannot save or commit')
})
