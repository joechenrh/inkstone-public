import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { IconClose } from './icons.js'
import { auth, backend } from '../api/index.js'
import { buildLabel } from '../version.js'
import {
  forgetChosenRepo,
  hasIdentity,
  installUrl,
  session,
  signOut as signOutOfGitHub,
} from '../auth/identity.js'
import { connection, forgetPairing, pairing, refresh, setPairing } from '../state/agent.js'
import {
  editorFontSize,
  setEditorFontSize,
  setShowAssets,
  showAssets,
} from '../state/settings.js'
import { DOC_THEMES, docTheme, findDocTheme, offersBothAppearances } from '../theme/docThemes.js'
import { closeSettings, isPhone, settingsOpen } from '../state/ui.js'
import { applyThemeChoice, readThemeChoice, selectDocTheme } from '../theme/useTheme.js'
import type { ThemeChoice } from '../theme/useTheme.js'
import './settingsmodal.css'

/**
 * What the Agent row says about a machine it has a pairing string for.
 *
 * Every branch is something the agent reported. "Connected" is a claim and does not appear —
 * a version number and a machine name are facts, and they are what a person needs when the thing
 * that broke is on a computer in another room.
 *
 * **The state fits on one line and the explanation goes under it.** They were one sentence, and
 * "Not answering — the agent is not running, or this browser blocks it" wrapped to two — which
 * both looked wrong beside every other row here and put back the height jump the row had just been
 * given a fixed height to stop.
 */
function agentState(): string {
  const conn = connection.value
  switch (conn.kind) {
    case 'unpaired': return 'Not set up'
    case 'checking': return 'Checking…'
    case 'offline': return 'Not answering'
    case 'stale': return 'Pairing string expired'
    case 'ready': {
      const here = conn.backends.filter((b) => b.found)
      if (here.length === 0) return `${conn.machine} · nothing to run`
      // The backend is not named here. This row answers "is it set up, and where" — the name
      // carries no information for the one-backend case that nearly everybody is in, and the
      // interface does not say `codex`. It appears in exactly two places, both diagnoses: the
      // drawer's picker when there is a choice to make, and the message that says to install one.
      const versions = here.map((b) => b.version).filter((v) => v !== null)
      return versions.length === 0 ? conn.machine : `${conn.machine} · ${versions.join(', ')}`
    }
  }
}

/** The line under it: why, and what to do about it. One per state, never longer than two lines. */
function agentHint(): ComponentChildren {
  const conn = connection.value
  switch (conn.kind) {
    case 'unpaired':
      return <>Run <code>inkstone-agent</code> on your own machine and paste the line it prints.</>
    case 'checking': return 'Asking that machine what it can run.'
    // `fetch` cannot tell a refused connection from a blocked one, so both causes have to be
    // named — but not at length. Safari is the whole browser half of it, and "not running" is the
    // other; the browser table lives in the design record, not in a settings row.
    case 'offline': return 'It may not be running. Safari also blocks this.'
    case 'stale': return 'The line changes each time the agent starts. Paste the new one.'
    case 'ready': return 'The line changes each time the agent starts, so paste it again after a restart.'
  }
}

export function SettingsModal() {
  const onGitHub = hasIdentity()
  const repositories = session.value?.repositories ?? []

  const isOpen = settingsOpen.value
  const [vaultRoot, setVaultRoot] = useState<string | null>(null)
  const [hasRemote, setHasRemote] = useState<boolean | null>(null)
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => readThemeChoice())
  const [pastedPairing, setPastedPairing] = useState('')
  const [pairingRefused, setPairingRefused] = useState(false)
  const activeTheme = findDocTheme(docTheme.value)
  const bothAppearances = offersBothAppearances(docTheme.value)

  useEffect(() => {
    if (!isOpen) return

    void backend.info().then((info) => setVaultRoot(info.label))
    void backend.gitStatus().then((s) => setHasRemote(s.hasRemote))
    setThemeChoice(readThemeChoice())
    // Opening Settings is when someone comes to check on this, so it is checked then. The row
    // would otherwise show whatever was true when the drawer was last open.
    if (pairing.value !== null) void refresh()
  }, [isOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  if (!isOpen) return null

  function handleTheme(choice: ThemeChoice) {
    setThemeChoice(choice)
    applyThemeChoice(choice)
  }

  function handleEditorFontSize(e: Event) {
    const val = Number((e.target as HTMLSelectElement).value)
    setEditorFontSize(val)
  }

  async function handleLogout() {
    // Whichever one signed the user in has to be the one that signs them out. Clearing a password
    // session on the GitHub route did nothing at all: the refresh cookie survived, and the reload
    // walked straight back in.
    if (hasIdentity()) await signOutOfGitHub()
    else await auth.signOut()
    location.reload()
  }

  return (
    <div class="ink-settings-backdrop" onClick={closeSettings}>
      <div
        class="ink-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        {/* A visible way out, not only the backdrop and Escape.
            On a phone the dialog is the screen, so there is no backdrop left to tap and no
            Escape key to press — settings was a room with no door. Shown on every size, because
            a dialog that can only be dismissed by clicking beside it is worse everywhere. */}
        <div class="ink-settings-header">
          <h2 class="ink-settings-title">Settings</h2>
          <button
            type="button"
            class="ink-iconbtn ink-settings-close"
            aria-label="Close settings"
            onClick={closeSettings}
          >
            <IconClose />
          </button>
        </div>

        {/* Everything below the header scrolls, so the way out stays where it was however many
            rows this grows. */}
        <div class="ink-settings-body">

        {/* Appearance is no longer a global switch: a theme that ships one look cannot show the
            other, so the control follows the theme rather than accepting a click that does
            nothing. */}
        <div class="ink-settings-row">
          <span class="ink-settings-label">Appearance</span>
          <div class="ink-theme-control">
            <button
              type="button"
              class="ink-theme-btn"
              aria-pressed={themeChoice === 'system'}
              disabled={!bothAppearances}
              onClick={() => handleTheme('system')}
            >
              System
            </button>
            <button
              type="button"
              class="ink-theme-btn"
              aria-pressed={themeChoice === 'light'}
              disabled={!bothAppearances}
              onClick={() => handleTheme('light')}
            >
              Light
            </button>
            <button
              type="button"
              class="ink-theme-btn"
              aria-pressed={themeChoice === 'dark'}
              disabled={!bothAppearances}
              onClick={() => handleTheme('dark')}
            >
              Dark
            </button>
            {!bothAppearances && (
              <span class="ink-theme-why">{activeTheme.name} is a {activeTheme.appearances[0]} theme</span>
            )}
          </div>
        </div>

        {/* You pick a theme by what it looks like, so the control shows what it looks like. */}
        <div class="ink-settings-row ink-settings-row--stacked">
          <span class="ink-settings-label">Document theme</span>
          <div class="ink-swatches">
            {DOC_THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                class="ink-swatch"
                data-doc-theme-preview={t.id}
                aria-pressed={docTheme.value === t.id}
                title={t.note}
                onClick={() => { selectDocTheme(t.id); setThemeChoice(readThemeChoice()) }}
              >
                <span class="ink-swatch-page">
                  <b>Aa</b>
                  <i class="a" /><i /><i class="short" />
                </span>
                <span class="ink-swatch-cap">
                  <span class="ink-swatch-name">{t.name}</span>
                  <span
                    class={`ink-swatch-dot ${t.appearances.length > 1 ? 'both' : t.appearances[0]}`}
                    aria-label={t.appearances.length > 1 ? 'light and dark' : `${t.appearances[0]} only`}
                  />
                </span>
              </button>
            ))}
          </div>
        </div>

        <div class="ink-settings-row">
          <label class="ink-settings-label" for="ink-editor-font-select">Editor font size</label>
          <select
            id="ink-editor-font-select"
            class="ink-settings-select"
            aria-label="Editor font size"
            value={editorFontSize.value}
            onChange={handleEditorFontSize}
          >
            <option value="12">12</option>
            <option value="14">14</option>
            <option value="16">16</option>
            <option value="18">18</option>
          </select>
        </div>

        {/* A two-button group rather than a new kind of control: the appearance row above is the
            same shape, and a window this application keeps trying to shrink does not need a second
            way to draw a choice of two. */}
        <div class="ink-settings-row">
          <span class="ink-settings-label">Pictures folder</span>
          <div class="ink-theme-control">
            <button
              type="button"
              class="ink-theme-btn"
              aria-pressed={!showAssets.value}
              onClick={() => { setShowAssets(false) }}
            >
              Hidden
            </button>
            <button
              type="button"
              class="ink-theme-btn"
              aria-pressed={showAssets.value}
              onClick={() => { setShowAssets(true) }}
            >
              Shown
            </button>
          </div>
        </div>

        <div class="ink-settings-row">
          <span class="ink-settings-label">{onGitHub ? 'Repository' : 'Vault'}</span>
          <span class="ink-settings-value">
            {vaultRoot ?? '…'}
            {/* The picker is skipped when the installation covers one repository, so this is the
                only way back to it — and with one, the only thing to change is on GitHub. */}
            {onGitHub && (repositories.length > 1
              ? (
                <button
                  type="button"
                  class="ink-settings-inline"
                  onClick={() => { forgetChosenRepo(); closeSettings() }}
                >
                  Change
                </button>
              )
              : (
                <a
                  class="ink-settings-inline"
                  href={installUrl.value ?? 'https://github.com/settings/installations'}
                  target="_blank"
                  rel="noreferrer"
                >
                  Change ↗
                </a>
              ))}
          </span>
        </div>

        {/* On the GitHub route the branch is the remote, so the row would always read "origin ✓". */}
        {!onGitHub && (
          <div class="ink-settings-row">
            <span class="ink-settings-label">Remote</span>
            <span class="ink-settings-value">
              {hasRemote === null ? '…' : hasRemote ? 'origin ✓' : 'No remote'}
            </span>
          </div>
        )}

        {/* One row, beside the other facts about this installation — not a screen and nothing in
            the top bar. It never says which backend it runs: see `src/agent/backend.ts`. */}
        <div class="ink-settings-row ink-settings-row--stacked">
          <span class="ink-settings-label">Agent</span>
          {/* A phone cannot reach an agent at all: the pairing string names `127.0.0.1`, which on
              this device is this device, and the relay that would fix it does not exist yet. A
              field here is an offer the app cannot keep — so it says what is true instead. It stays
              visible rather than disappearing, because "where did that setting go" is a worse
              question than "why is it not here yet". */}
          {isPhone.value && pairing.value === null
            ? <span class="ink-pairing-state">Set up on a computer</span>
            : pairing.value === null
            ? (
              <div class="ink-pairing">
                <input
                  class="ink-pairing-field"
                  type="text"
                  spellcheck={false}
                  autocomplete="off"
                  placeholder="127.0.0.1:63735/…"
                  aria-label="Pairing string from the agent"
                  value={pastedPairing}
                  onInput={(e) => {
                    setPastedPairing((e.target as HTMLInputElement).value)
                    setPairingRefused(false)
                  }}
                />
                <button
                  type="button"
                  class="ink-pairing-add"
                  disabled={pastedPairing.trim() === ''}
                  onClick={() => { if (!setPairing(pastedPairing)) setPairingRefused(true) }}
                >
                  Add
                </button>
              </div>
            )
            : (
              <div class="ink-pairing">
                <span class="ink-pairing-state" title={agentState()}>
                  {agentState()}
                </span>
                <button type="button" class="ink-settings-inline" onClick={forgetPairing}>
                  Remove
                </button>
              </div>
            )}
          <span class="ink-pairing-hint">
            {isPhone.value && pairing.value === null
              ? 'The agent runs on your own computer, and this phone has no way to reach it yet.'
              : pairingRefused
              // Not "invalid input": the two ways to get this wrong are pasting half of it and
              // pasting a host that is not this machine, and only one of them is a typo.
              ? 'That is not a pairing string. It looks like 127.0.0.1:63735/ followed by a token, and the host must be this machine.'
              : agentHint()}
          </span>
        </div>

        {/* A fact beside the other facts, not a screen. The commit is what makes a bug report
            answerable — a version number names a fortnight of builds and this names one. No link:
            the source repository is private. */}
        <div class="ink-settings-row">
          <span class="ink-settings-label">Version</span>
          <span class="ink-settings-value ink-settings-build">{buildLabel}</span>
        </div>

        </div>

        <div class="ink-settings-footer">
          <button type="button" class="ink-logout-btn" onClick={() => void handleLogout()}>
            Log out
          </button>
        </div>
      </div>
    </div>
  )
}
