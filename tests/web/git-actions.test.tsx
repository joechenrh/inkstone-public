import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GitFooter } from '../../src/web/layout/GitFooter.js'
import { closeCommit, commitOpen } from '../../src/web/state/commit.js'
import { gitStatus } from '../../src/web/state/git.js'
import * as apiModule from '../../src/web/api/index.js'

beforeEach(() => { gitStatus.value = { dirty: true, branch: 'main', hasRemote: true, ahead: 3 } })

describe('git footer buttons', () => {
  // The button used to commit on the spot with a generated message, which is why the log read as a
  // list of nothing. It now opens the panel that says what is about to be committed, and the commit
  // happens there — with whatever message was written.
  it('when dirty, the commit button opens the panel rather than committing', async () => {
    const commit = vi.spyOn(apiModule.backend, 'commit').mockResolvedValue({ sha: 'a'.repeat(40), files: ['a.md'] })
    // The changes are read before the panel opens, so it never appears empty and then fills in.
    vi.spyOn(apiModule.backend, 'gitChanges').mockResolvedValue({
      changes: [{ path: 'a.md', status: 'modified', added: 1, removed: 0, diff: '@@ -1 +1 @@\n+a' }],
    })
    render(<GitFooter />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    await waitFor(() => expect(commitOpen.value).toBe(true))
    expect(commit, 'nothing is written until the panel says so').not.toHaveBeenCalled()
    closeCommit()
  })
  it('the commit button is disabled when not dirty', () => {
    gitStatus.value = { dirty: false, branch: 'main', hasRemote: true, ahead: 0 }
    render(<GitFooter />)
    const btn = screen.getByRole('button', { name: 'Commit' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })
  it('renders the git-branch icon to the left of the branch name', () => {
    const { container } = render(<GitFooter />)
    // IconGitBranch renders an svg inside the branch span, before the branch name
    const branch = container.querySelector('.ink-git-branch')!
    expect(branch.querySelector('svg')).toBeTruthy()
    expect(branch.firstElementChild?.tagName.toLowerCase()).toBe('svg')
  })
  it('shows Push 3 when hasRemote and ahead>0', () => {
    render(<GitFooter />)
    expect(screen.getByText(/Push 3/)).toBeTruthy()
  })
  // The button is the confirmation. It said what it would do and how much, then asked again in
  // running text inside the status bar — a question and two answers, for an operation that is
  // additive and outward-only: it sends commits that already exist to a remote that already exists.
  it('push happens on the press, with no second question', async () => {
    const push = vi.spyOn(apiModule.backend, 'push').mockResolvedValue({ pushed: 3 })
    vi.spyOn(apiModule.backend, 'gitStatus').mockResolvedValue({ dirty: true, branch: 'main', hasRemote: true, ahead: 0 })
    render(<GitFooter />)
    fireEvent.click(screen.getByText(/Push 3/))
    await waitFor(() => expect(push).toHaveBeenCalled())
    expect(screen.queryByText(/Confirm/), 'no confirmation step').toBeNull()
  })
  it('does not show push when there is no remote', () => {
    gitStatus.value = { dirty: true, branch: 'main', hasRemote: false, ahead: 0 }
    render(<GitFooter />)
    expect(screen.queryByText(/Push/)).toBeNull()
  })
})
