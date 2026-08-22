// The reader's side: /share/<id>, and what saving a copy does to somebody else's vault.
// The panel that makes the link is tests/web/share-panel.test.tsx.
import { render, waitFor } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIdentity, chosenRepo, session } from '../../src/web/auth/identity.js'
import { fakeIdentity } from '../../src/web/auth/fake.js'
import { content, dirty } from '../../src/web/state/document.js'
import { currentPath } from '../../src/web/state/vault.js'
import { isPhone } from '../../src/web/state/ui.js'
import { BackendError, useBackend } from '../../src/web/api/index.js'
import type { VaultBackend } from '../../src/web/api/backend.js'
import { SharedNote } from '../../src/web/share/SharedNote.js'
import { saveCopy } from '../../src/web/share/save.js'
import {
  closeSharePanel,
  sharedByPath,
  sharingAvailable,
  DAY_MS,
} from '../../src/web/state/share.js'

// This page renders markdown with lute, a 4MB runtime asset. What it renders is Vditor's business.
vi.mock('../../src/web/share/render.js', () => ({ renderMarkdown: () => Promise.resolve() }))

const NOW = 1_700_000_000_000

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: unknown, init?: RequestInit) => handler(String(url), init))
  vi.stubGlobal('fetch', spy)
  return spy
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  sharingAvailable.value = true
  sharedByPath.value = {}
  currentPath.value = 'notes/a.md'
  content.value = '# A note\n\nbody\n'
  dirty.value = false
  isPhone.value = false
  session.value = { login: 'octocat', repositories: [] }
  chosenRepo.value = { owner: 'octocat', name: 'notes', defaultBranch: 'main' }
  useIdentity(fakeIdentity({ login: 'octocat', repositories: [], token: 'tok', signedIn: true }))
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } })
})

afterEach(() => {
  closeSharePanel()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('saving a copy into the reader\'s own notes', () => {
  /** Only the two calls saveCopy makes; everything else would be a bug if it were reached. */
  function vault(files: Record<string, string>) {
    const written: Record<string, string> = {}
    useBackend({
      async readFile(path: string) {
        const content = files[path]
        if (content === undefined) throw new BackendError('not found', 404)
        return { path, content, rev: '1', modifiedAt: null }
      },
      async writeFile(path: string, content: string) {
        written[path] = content
        return { rev: '2', modifiedAt: null }
      },
    } as unknown as VaultBackend)
    return written
  }

  it('writes the note when nothing is in the way', async () => {
    const written = vault({})
    expect(await saveCopy('hello', 'shared/a.md')).toEqual({ kind: 'saved', path: 'shared/a.md' })
    expect(written).toEqual({ 'shared/a.md': 'hello' })
  })

  it('never overwrites a different note that has the same name', async () => {
    const written = vault({ 'shared/a.md': 'something else' })
    expect(await saveCopy('hello', 'shared/a.md')).toEqual({ kind: 'saved', path: 'shared/a (2).md' })
    // Two copies is recoverable; a lost note is not.
    expect(written).toEqual({ 'shared/a (2).md': 'hello' })
  })

  it('recognises a note it already has by its text, not its name', async () => {
    const written = vault({ 'shared/a.md': 'hello' })
    expect(await saveCopy('hello', 'shared/a.md')).toEqual({ kind: 'already', path: 'shared/a.md' })
    expect(written).toEqual({})
  })

  it('lets a real failure through rather than writing to the next name along', async () => {
    useBackend({
      async readFile() { throw new BackendError('rate limited', 403) },
      async writeFile() { throw new Error('should never be reached') },
    } as unknown as VaultBackend)
    await expect(saveCopy('hello', 'shared/a.md')).rejects.toThrow('rate limited')
  })
})

describe('the reader\'s page, opened by the person who shared it', () => {
  /** Answers the two calls the page makes: the note, and this account's own shares. */
  function serve(over: { shares?: { id: string }[] } = {}) {
    return stubFetch((url) => {
      if (url.startsWith('/api/share/')) {
        return Response.json({
          title: 'A note', path: 'notes/a.md', content: '# A note', sharedAt: NOW, expiresAt: NOW + DAY_MS,
        })
      }
      if (url === '/api/shares') return Response.json({ shares: over.shares ?? [] })
      return new Response('{}', { status: 404 })
    })
  }

  const signedIn = () => fakeIdentity({ login: 'octocat', repositories: [], token: 'tok', signedIn: true })

  it('says the note is yours and offers the way back, not a second copy', async () => {
    serve({ shares: [{ id: 'k3f9x2' }] })
    const { container, getByText } = render(<SharedNote id="k3f9x2" identity={signedIn()} />)

    await waitFor(() => { getByText('your shared note') })
    // Saving your own note into shared/ is a duplicate of something you are reading out of your
    // own repository.
    expect(container.querySelector('.ink-shared-cta')).toBeNull()
    expect(container.querySelector('.ink-shared-back')?.getAttribute('href')).toBe('/')
  })

  it('offers the save to somebody else\'s reader', async () => {
    serve({ shares: [{ id: 'someone-elses' }] })
    const { container, getByText } = render(<SharedNote id="k3f9x2" identity={signedIn()} />)

    await waitFor(() => { getByText('shared note') })
    await waitFor(() => { expect(container.querySelector('.ink-shared-cta')).toBeTruthy() })
    expect(container.querySelector('.ink-shared-back')).toBeNull()
  })

  it('treats an unanswerable question as somebody else\'s, never as a dead end', async () => {
    stubFetch((url) => url.startsWith('/api/share/')
      ? Response.json({ title: 'A note', path: 'notes/a.md', content: '# A note', sharedAt: NOW, expiresAt: NOW + DAY_MS })
      : new Response('{}', { status: 500 }))
    const { container } = render(<SharedNote id="k3f9x2" identity={signedIn()} />)

    await waitFor(() => { expect(container.querySelector('.ink-shared-cta')).toBeTruthy() })
  })
})
