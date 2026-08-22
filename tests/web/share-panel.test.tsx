// The sharer's side: the menu item that carries the state, the panel, and the calls it makes.
// The reader's page is tests/web/share-reader.test.tsx.
import { render, waitFor } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIdentity, chosenRepo, session } from '../../src/web/auth/identity.js'
import { fakeIdentity } from '../../src/web/auth/fake.js'
import { content, dirty } from '../../src/web/state/document.js'
import { currentPath } from '../../src/web/state/vault.js'
import { isPhone } from '../../src/web/state/ui.js'
import { SharePanel } from '../../src/web/share/SharePanel.js'
import { shareMenuItem } from '../../src/web/share/menuItem.js'
import { createShare, listShares, stopShare } from '../../src/web/share/api.js'
import {
  closeSharePanel,
  daysLeft,
  openSharePanel,
  sharedByPath,
  sharePanel,
  sharePanelPath,
  sharingAvailable,
  titleOf,
  DAY_MS,
} from '../../src/web/state/share.js'

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

describe('the share menu item', () => {
  it('is absent where there is nothing to offer', () => {
    sharingAvailable.value = false
    expect(shareMenuItem('notes/a.md')).toEqual([])
  })

  it('offers to share a note that is not shared', () => {
    expect(shareMenuItem('notes/a.md')[0]?.label).toBe('Share…')
  })

  it('carries the state as its label, and warns only in the last days', () => {
    const at = (days: number) => {
      sharedByPath.value = {
        'notes/a.md': { id: 'k3f9x2', repo: 'octocat/notes', path: 'notes/a.md', expiresAt: NOW + days * DAY_MS },
      }
      return shareMenuItem('notes/a.md')[0]!
    }
    expect(at(28).label).toBe('Shared · 28 days left')
    expect(at(28).warn).toBe(false)
    expect(at(2).label).toBe('Shared · 2 days left')
    // The number is the warning; nothing else nags.
    expect(at(2).warn).toBe(true)
    expect(at(1).label).toBe('Shared · 1 day left')
  })
})

describe('days left', () => {
  it('rounds up, so "1 day left" never means an hour', () => {
    expect(daysLeft(NOW + DAY_MS * 0.1, NOW)).toBe(1)
    expect(daysLeft(NOW + DAY_MS * 29.5, NOW)).toBe(30)
    expect(daysLeft(NOW - 1, NOW)).toBe(0)
  })
})

describe('the title a reader sees', () => {
  it('is the note\'s first heading', () => {
    expect(titleOf('notes/a.md', '# 一篇中文笔记\n\nbody')).toBe('一篇中文笔记')
    expect(titleOf('notes/a.md', 'intro\n\n### Deeper\n')).toBe('Deeper')
  })

  it('falls back to what the author called the file', () => {
    expect(titleOf('notes/Some Note.md', 'no heading here')).toBe('Some Note')
  })
})

describe('the share panel', () => {
  it('shows the link and waits to be asked before touching the clipboard', async () => {
    const fetchSpy = stubFetch(() => Response.json({
      id: 'k3f9x2', repo: 'octocat/notes', path: 'notes/a.md', expiresAt: NOW + 30 * DAY_MS,
    }))

    openSharePanel('notes/a.md')
    const { getByText, container } = render(<SharePanel />)

    await vi.waitFor(() => { expect(sharePanel.value.kind).toBe('ready') })
    expect(fetchSpy).toHaveBeenCalledWith('/api/share', expect.objectContaining({ method: 'POST' }))
    expect(container.querySelector('.ink-share-url')?.textContent).toContain('/share/k3f9x2')
    // Not copied on its own: announcing a copy nobody asked for and retracting it two seconds
    // later is noise, and an automatic write is what iOS refuses outside a user gesture.
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()

    container.querySelector<HTMLButtonElement>('.ink-share-btn')!.click()
    await vi.waitFor(() => { expect(navigator.clipboard.writeText).toHaveBeenCalledWith('http://localhost:3000/share/k3f9x2') })
    // Both facts, in the moment they matter.
    // One sentence, split across elements so the number can take the warning colour.
    expect(container.querySelector('.ink-share-meta')?.textContent?.replace(/\s+/g, ' '))
      .toBe('Anyone with the link can read this for 30 days.Update & extend')
    getByText('Stop sharing')
  })

  it('offers Select rather than an error when the clipboard refuses', async () => {
    stubFetch(() => Response.json({ id: 'k3f9x2', repo: 'r', path: 'notes/a.md', expiresAt: NOW + DAY_MS }))
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })

    openSharePanel('notes/a.md')
    const { container } = render(<SharePanel />)
    await vi.waitFor(() => { expect(sharePanel.value.kind).toBe('ready') })
    container.querySelector<HTMLButtonElement>('.ink-share-btn')!.click()

    // A failure with an obvious manual fix is not worth a sentence.
    await vi.waitFor(() => {
      expect(container.querySelector('.ink-share-btn')?.textContent).toBe('Select')
    })
    expect(container.querySelector('.ink-share-error')).toBeNull()
  })

  it('names the size and the cap when a note is too big', async () => {
    content.value = 'x'.repeat(93_000)
    stubFetch(() => new Response(JSON.stringify({ kind: 'too-large', maxBytes: 65536 }), { status: 413 }))

    openSharePanel('notes/a.md')
    const { getByText, container } = render(<SharePanel />)

    await waitFor(() => { getByText('Too large to share') })
    // "Too large" alone leaves someone guessing how much to cut.
    getByText('This note is 91KB. Shared notes can be up to 64KB.')
    // Retrying cannot help, so nothing offers to.
    expect(container.querySelector('.ink-share-btn.ghost')).toBeNull()
  })

  it('says nothing was shared, and offers to try again, when the server is unreachable', async () => {
    stubFetch(() => { throw new Error('ENETUNREACH') })

    openSharePanel('notes/a.md')
    const { getByText } = render(<SharePanel />)

    await waitFor(() => { getByText('Could not reach the server') })
    getByText('Nothing was shared.')
    getByText('Try again')
  })

  it('names the limit and the way out when there are too many', async () => {
    stubFetch(() => new Response(JSON.stringify({ kind: 'too-many', limit: 20 }), { status: 409 }))

    openSharePanel('notes/a.md')
    const { getByText } = render(<SharePanel />)

    await waitFor(() => { getByText('Too many shared notes') })
    getByText('You have 20 notes shared, which is the limit. Stop sharing one first.')
  })

  it('shows an existing share without republishing it', async () => {
    const fetchSpy = stubFetch(() => Response.json({}))
    sharedByPath.value = {
      'notes/a.md': { id: 'k3f9x2', repo: 'octocat/notes', path: 'notes/a.md', expiresAt: NOW + 2 * DAY_MS },
    }

    openSharePanel('notes/a.md')
    const { container } = render(<SharePanel />)

    // Opening the panel to check a link must not publish whatever has been written since.
    expect(fetchSpy).not.toHaveBeenCalledWith('/api/share', expect.objectContaining({ method: 'POST' }))
    expect(container.querySelector('.ink-share-url')?.textContent).toContain('/share/k3f9x2')
    expect(container.querySelector('.ink-share-soon')?.textContent).toBe('2 days')
  })

  it('is a sheet on a phone and a modal on a desktop', async () => {
    stubFetch(() => Response.json({ id: 'k3f9x2', repo: 'r', path: 'notes/a.md', expiresAt: NOW + DAY_MS }))
    openSharePanel('notes/a.md')

    const desktop = render(<SharePanel />)
    expect(desktop.container.querySelector('.ink-share--sheet')).toBeNull()
    desktop.unmount()

    isPhone.value = true
    const phone = render(<SharePanel />)
    expect(phone.container.querySelector('.ink-share--sheet')).toBeTruthy()
  })
})

describe('stopping a share', () => {
  it('asks the server, forgets the note, and says what it did', async () => {
    const calls: { url: string; method?: string }[] = []
    stubFetch((url, init) => {
      calls.push({ url, method: init?.method })
      return new Response(null, { status: 204 })
    })
    sharedByPath.value = {
      'notes/a.md': { id: 'k3f9x2', repo: 'octocat/notes', path: 'notes/a.md', expiresAt: NOW + DAY_MS },
    }

    openSharePanel('notes/a.md')
    const { container, getByText } = render(<SharePanel />)
    container.querySelector<HTMLButtonElement>('.ink-share-stop')!.click()

    // It reports rather than vanishing: everything this changes is somewhere the user cannot see.
    await vi.waitFor(() => { expect(sharePanel.value.kind).toBe('stopped') })
    getByText('No longer shared')
    expect(calls).toEqual([{ url: '/api/share/k3f9x2', method: 'DELETE' }])
    // The menu goes back to offering a share rather than reporting a dead one.
    expect(sharedByPath.value['notes/a.md']).toBeUndefined()
    expect(shareMenuItem('notes/a.md')[0]?.label).toBe('Share…')
  })

  it('says so, and keeps the share, when the server refuses', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'nope' }), { status: 400 }))
    sharedByPath.value = {
      'notes/a.md': { id: 'k3f9x2', repo: 'octocat/notes', path: 'notes/a.md', expiresAt: NOW + DAY_MS },
    }

    openSharePanel('notes/a.md')
    const { container, getByText } = render(<SharePanel />)
    container.querySelector<HTMLButtonElement>('.ink-share-stop')!.click()

    await waitFor(() => { getByText('The server would not take it') })
    // Still shared, because the server still thinks so.
    expect(sharedByPath.value['notes/a.md']).toBeDefined()
  })
})

describe('what goes on the wire', () => {
  it('declares JSON only when it is sending some', async () => {
    const seen: { url: string; method?: string; ct?: string }[] = []
    const spy = vi.fn(async (url: unknown, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url: String(url), method: init?.method, ct: h['content-type'] })
      return url === '/api/shares'
        ? Response.json({ shares: [] })
        : new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', spy)

    await listShares('tok')
    await stopShare('tok', 'k3f9x2')

    // A body-less request that declares a JSON body is a 400 from Fastify before any route sees
    // it, reported as a flat "bad request" — which is what Stop sharing did for a whole release.
    expect(seen).toEqual([
      { url: '/api/shares', method: 'GET', ct: undefined },
      { url: '/api/share/k3f9x2', method: 'DELETE', ct: undefined },
    ])
  })

  it('still declares it for a share, which has one', async () => {
    let ct: string | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      ct = (init?.headers as Record<string, string>)['content-type']
      return Response.json({ id: 'k', repo: 'r', path: 'p', expiresAt: 0 })
    }))

    await createShare('tok', { repo: 'r', path: 'p', title: 't', content: 'c' })
    expect(ct).toBe('application/json')
  })
})

describe('the menu after an optimistic first paint', () => {
  it('has an identity to ask before any child effect runs', async () => {
    // Preact runs a child's effects first, and GitHubRoot now draws the application on its first
    // render — so App's mount effect, which is what loads this account's shares, runs before
    // GitHubRoot's. If the provider were installed in an effect it would not be there yet, and
    // `loadShares` fails silently: every menu would say `Share…` while the server knew otherwise.
    const { useIdentity, hasIdentity } = await import('../../src/web/auth/identity.js')
    const { GitHubRoot } = await import('../../src/web/auth/GitHubRoot.js')

    // Wind it back to "nothing installed", which is what a fresh page load looks like.
    useIdentity(undefined as never)
    chosenRepo.value = { owner: 'octocat', name: 'notes', defaultBranch: 'main' }

    const identity = fakeIdentity({ login: 'you', repositories: [], token: 't', signedIn: true })
    render(<GitHubRoot identity={identity} />)

    expect(hasIdentity()).toBe(true)
  })
})
