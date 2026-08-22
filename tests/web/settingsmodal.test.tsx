import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../../src/web/components/SettingsModal.js'
import { settingsOpen } from '../../src/web/state/ui.js'
import { editorFontSize } from '../../src/web/state/settings.js'
import * as apiModule from '../../src/web/api/index.js'

beforeEach(() => { settingsOpen.value = true; localStorage.clear()
  vi.spyOn(apiModule.backend, 'info').mockResolvedValue({ label: '/vault' })
  // The modal asks for the repository's state as it opens. Unstubbed, that is a relative-URL
  // `fetch` in jsdom, which rejects — five unhandled rejections that failed `pnpm test` while
  // every test in it passed.
  vi.spyOn(apiModule.backend, 'gitStatus').mockResolvedValue({ branch: 'main', ahead: 0, dirty: false, hasRemote: false }) })

describe('SettingsModal', () => {
  it('renders the appearance/font-size/vault rows when open', async () => {
    render(<SettingsModal />)
    expect(screen.getByText('Appearance')).toBeTruthy()
    expect(screen.getByText('Editor font size')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('/vault')).toBeTruthy())
  })
  it('changing the editor font size writes the signal', () => {
    render(<SettingsModal />)
    fireEvent.change(screen.getByLabelText('Editor font size'), { target: { value: '18' } })
    expect(editorFontSize.value).toBe(18)
  })
  it('closes on Esc', () => {
    render(<SettingsModal />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(settingsOpen.value).toBe(false)
  })
  it('does not render when settingsOpen=false', () => {
    settingsOpen.value = false
    const { container } = render(<SettingsModal />)
    expect(container.querySelector('.ink-settings')).toBeNull()
  })
  it('names the build, and does not link to it', () => {
    // The source repository is private: a link would 404 for anyone who is not a collaborator and
    // would name the repository to everyone else. The sha stays because it makes a bug report
    // answerable — a version number names a fortnight of builds and this names one.
    render(<SettingsModal />)
    const value = document.querySelector('.ink-settings-build')
    expect(value?.textContent).toMatch(/^\d+\.\d+\.\d+ · \S+$/)
    expect(value?.querySelector('a')).toBeNull()
  })

  it('log out signs out', async () => {
    const logout = vi.spyOn(apiModule.auth, 'signOut').mockResolvedValue()
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Log out'))
    await waitFor(() => expect(logout).toHaveBeenCalled())
  })
})
