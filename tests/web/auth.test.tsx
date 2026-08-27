import { fireEvent, render, screen } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeIdentity } from '../../src/web/auth/fake.js'
import { GitHubRoot } from '../../src/web/auth/GitHubRoot.js'
import { GitHubSignIn } from '../../src/web/auth/GitHubSignIn.js'
import {
  chooseRepo,
  chosenRepo,
  forgetChosenRepo,
  identityError,
  installUrl,
  restoreSession,
  session,
  signOut,
  useIdentity,
} from '../../src/web/auth/identity.js'
import { RepoPicker } from '../../src/web/auth/RepoPicker.js'
import { isPhone } from '../../src/web/state/ui.js'

const REPOS = [
  { owner: 'octocat', name: 'notes', defaultBranch: 'main' },
  { owner: 'octocat', name: 'journal', defaultBranch: 'trunk' },
]

beforeEach(() => {
  localStorage.clear()
  session.value = null
  chosenRepo.value = null
  identityError.value = null
  isPhone.value = false
  installUrl.value = null
})

describe('signing in', () => {
  it('is one button and no form — there is no account here to fill in', () => {
    useIdentity(fakeIdentity({ login: 'you', repositories: REPOS, token: 't' }))
    const { container } = render(<GitHubSignIn />)
    expect(screen.getByRole('button', { name: /continue with github/i })).toBeTruthy()
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('form')).toBeNull()
  })

  it('states what is being asked for, in the words that have to stay true', () => {
    useIdentity(fakeIdentity({ login: 'you', repositories: REPOS, token: 't' }))
    render(<GitHubSignIn />)
    expect(screen.getByText(/You pick which repository, on GitHub's screen/)).toBeTruthy()
    expect(screen.getByText(/read and write files in it\. Nothing else/i)).toBeTruthy()
    expect(screen.getByText(/never through this server/i)).toBeTruthy()
    // The one claim that is a limitation rather than a boast, and so the one most worth checking.
    // It shares its line with the revocation link: two items said one thing between them.
    expect(screen.getByText(/Your GitHub session does/i)).toBeTruthy()
    // Revocation is a link the user can follow rather than a promise they have to take.
    expect(screen.getByRole('link', { name: /github settings/i }).getAttribute('href'))
      .toBe('https://github.com/settings/installations')
  })

  it('leaves for GitHub when pressed, and finds a session on the way back', async () => {
    const identity = fakeIdentity({ login: 'you', repositories: REPOS, token: 't' })
    const begin = vi.spyOn(identity, 'begin')
    useIdentity(identity)

    render(<GitHubSignIn />)
    fireEvent.click(screen.getByRole('button', { name: /continue with github/i }))
    expect(begin).toHaveBeenCalled()

    await restoreSession()
    expect(session.value?.login).toBe('you')
  })

  it('says so when GitHub cannot be reached, rather than showing an empty app', async () => {
    useIdentity({
      begin: () => {},
      restore: () => Promise.reject(new Error('Could not reach GitHub')),
      renew: () => Promise.resolve('t'),
    token: () => Promise.resolve('t'),
      signOut: () => Promise.resolve(),
    })
    await restoreSession()
    render(<GitHubSignIn />)
    expect(screen.getByRole('alert').textContent).toContain('Could not reach GitHub')
  })
})

describe('choosing a repository', () => {
  beforeEach(() => {
    session.value = { login: 'you', repositories: REPOS }
  })

  it('lists what was ticked on GitHub, with no filter over three rows', () => {
    const { container } = render(<RepoPicker />)
    expect(screen.getByText('notes')).toBeTruthy()
    expect(screen.getByText('journal')).toBeTruthy()
    expect(container.querySelector('input')).toBeNull()
  })

  it('shows each repository\'s own default branch', () => {
    render(<RepoPicker />)
    expect(screen.getByText('trunk')).toBeTruthy()
  })

  it('focuses the first row, since autoFocus does not fire on a late mount', () => {
    render(<RepoPicker />)
    expect(document.activeElement?.textContent).toContain('notes')
  })

  it('remembers the choice, so a reload does not ask again', () => {
    render(<RepoPicker />)
    fireEvent.click(screen.getByText('journal'))
    expect(chosenRepo.value?.name).toBe('journal')
    // The whole repository, default branch included: the app reads this back before the network
    // answers, and the backend cannot be built without the branch.
    expect(JSON.parse(localStorage.getItem('inkstone.repo')!))
      .toEqual({ owner: 'octocat', name: 'journal', defaultBranch: 'trunk' })
  })

  it('forgets a choice the installation no longer offers', async () => {
    chooseRepo(REPOS[1]!)
    useIdentity(fakeIdentity({ login: 'you', repositories: [REPOS[0]!], token: 't', signedIn: true }))
    await restoreSession()
    // Pointing the app at a repository it can no longer read would fail on the first request.
    expect(chosenRepo.value).toBeNull()
  })

  it('restores a choice that is still on offer', async () => {
    chooseRepo(REPOS[0]!)
    useIdentity(fakeIdentity({ login: 'you', repositories: REPOS, token: 't', signedIn: true }))
    await restoreSession()
    expect(chosenRepo.value?.name).toBe('notes')
  })

  it('offers the way onward when the installation covers nothing', () => {
    // Signing in and installing are separate acts on GitHub, and a first-time user has done only
    // the first. A sentence with no button here is a dead end.
    session.value = { login: 'you', repositories: [] }
    installUrl.value = 'https://github.com/apps/inkstone-notes/installations/new'
    render(<RepoPicker />)
    expect(screen.getByRole('link', { name: /choose a repository on github/i }).getAttribute('href'))
      .toBe('https://github.com/apps/inkstone-notes/installations/new')
  })

  it('falls back to GitHub\'s own page when this server has no App slug', () => {
    session.value = { login: 'you', repositories: [] }
    installUrl.value = null
    render(<RepoPicker />)
    expect(screen.getByRole('link', { name: /choose a repository on github/i }).getAttribute('href'))
      .toBe('https://github.com/settings/installations')
  })

  it('drops the link out to GitHub on a phone, where Settings already has it', () => {
    isPhone.value = true
    render(<RepoPicker />)
    expect(screen.queryByText(/change on github/i)).toBeNull()
  })
})

describe('signing out', () => {
  it('uses whatever signed the user in', async () => {
    // The password route's logout did nothing here: the refresh cookie survived it, and the
    // reload walked straight back in. This is the regression that made the button look dead.
    const identity = fakeIdentity({ login: 'you', repositories: REPOS, token: 't', signedIn: true })
    const providerSignOut = vi.spyOn(identity, 'signOut')
    useIdentity(identity)
    await restoreSession()
    expect(session.value).not.toBeNull()

    await signOut()
    expect(providerSignOut).toHaveBeenCalled()
    expect(session.value).toBeNull()
    expect(chosenRepo.value).toBeNull()
  })

  it('forgetting the repository leaves the session alone', () => {
    session.value = { login: 'you', repositories: REPOS }
    chooseRepo(REPOS[0]!)
    forgetChosenRepo()
    expect(chosenRepo.value).toBeNull()
    expect(localStorage.getItem('inkstone.repo')).toBeNull()
    // Still signed in — this is "show me the list again", not "sign me out".
    expect(session.value).not.toBeNull()
  })
})

describe('what the app draws while it is restoring a session', () => {
  it('draws nothing on a browser that has never chosen a repository', () => {
    localStorage.clear()
    chosenRepo.value = null
    const { container } = render(<GitHubRoot identity={fakeIdentity({ login: 'x', repositories: [], token: 't' })} />)
    // Nothing to be optimistic about: this is a first visit, and the sign-in screen is one tick away.
    expect(container.innerHTML).toBe('')
  })

  it('draws the application straight away on one that has', () => {
    const repo = { owner: 'octocat', name: 'notes', defaultBranch: 'main' }
    chooseRepo(repo)
    // Read back with no network at all — the point of storing the whole repository.
    expect(JSON.parse(localStorage.getItem('inkstone.repo')!)).toEqual(repo)

    chosenRepo.value = repo
    const { container } = render(<GitHubRoot identity={fakeIdentity({ login: 'x', repositories: [repo], token: 't' })} />)
    // Restoring costs three round trips; the shell is not made to wait for them.
    expect(container.innerHTML).not.toBe('')
  })
})

describe('a browser that chose its repository before the format changed', () => {
  it('is upgraded on the next load, so it stops waiting on the network to draw', async () => {
    // What the old build wrote: no default branch, so nothing can be built from it offline.
    localStorage.setItem('inkstone.repo', 'octocat/journal')
    useIdentity(fakeIdentity({ login: 'you', repositories: REPOS, token: 't', signedIn: true }))

    await restoreSession()

    expect(chosenRepo.value).toEqual(REPOS[1])
    // Rewritten in place. Without this the optimistic first paint never applies to anyone who
    // already had a repository — which is everyone it was written for.
    expect(JSON.parse(localStorage.getItem('inkstone.repo')!)).toEqual(REPOS[1])
  })
})
