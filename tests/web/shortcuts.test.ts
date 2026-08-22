import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readOnly, setReadOnly, sourceMode, viewMode } from '../../src/web/state/settings.js'
import { handleShortcut } from '../../src/web/state/shortcuts.js'
import { leftPanelOpen, rightPanelOpen, sidebarView } from '../../src/web/state/ui.js'
import { cancelPending, pendingOp } from '../../src/web/state/vault.js'

function key(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { cancelable: true, ...init })
}

beforeEach(() => {
  leftPanelOpen.value = true
  rightPanelOpen.value = false
  sidebarView.value = 'files'
  setReadOnly(false)
  cancelPending()
  viewMode.value = 'edit'
})

describe('handleShortcut', () => {
  it('ignores keys without Ctrl/Cmd', () => {
    expect(handleShortcut(key({ key: '1' }))).toBe(false)
    expect(sidebarView.value).toBe('files')
  })

  it('Cmd+2 shows the outline', () => {
    expect(handleShortcut(key({ key: '2', metaKey: true }))).toBe(true)
    expect(sidebarView.value).toBe('outline')
  })

  it('Cmd+E toggles read-only, both ways', () => {
    expect(handleShortcut(key({ key: 'e', metaKey: true }))).toBe(true)
    expect(readOnly.value).toBe(true)
    handleShortcut(key({ key: 'e', metaKey: true }))
    expect(readOnly.value).toBe(false)
  })

  it('Cmd+1 shows the file tree', () => {
    sidebarView.value = 'outline'
    handleShortcut(key({ key: '1', metaKey: true }))
    expect(sidebarView.value).toBe('files')
  })

  it('opens a collapsed sidebar when selecting a view', () => {
    leftPanelOpen.value = false
    handleShortcut(key({ key: '2', ctrlKey: true }))
    expect(leftPanelOpen.value).toBe(true)
    expect(sidebarView.value).toBe('outline')
  })

  // Vditor hard-codes Ctrl/Cmd+Alt+1..6 for heading levels; intercepting them would
  // break heading shortcuts inside the editor.
  it('does not intercept Cmd+Alt+<digit>', () => {
    expect(handleShortcut(key({ key: '1', code: 'Digit1', metaKey: true, altKey: true }))).toBe(false)
    expect(sidebarView.value).toBe('files')
  })

  // Cmd+N and Shift+Cmd+N are the conventional keys and the browser keeps both — the page never
  // sees the event — so creating is on Alt. Matched on `code`, because holding Option on macOS
  // rewrites `key` to the composed character: Cmd+Alt+N arrives as "˜".
  describe('Cmd+Alt+N / Cmd+Alt+F create, whatever `key` says', () => {
    it('opens a create-file op and shows the tree it is typed into', () => {
      sidebarView.value = 'outline'
      leftPanelOpen.value = false
      expect(handleShortcut(key({ key: '˜', code: 'KeyN', metaKey: true, altKey: true }))).toBe(true)
      expect(pendingOp.value?.kind).toBe('create-file')
      expect(sidebarView.value).toBe('files')
      expect(leftPanelOpen.value).toBe(true)
    })

    it('opens a create-dir op', () => {
      expect(handleShortcut(key({ key: 'ƒ', code: 'KeyF', metaKey: true, altKey: true }))).toBe(true)
      expect(pendingOp.value?.kind).toBe('create-dir')
    })

    it('Cmd+Alt+M toggles the source view, both ways', () => {
      expect(handleShortcut(key({ key: 'µ', code: 'KeyM', metaKey: true, altKey: true }))).toBe(true)
      expect(sourceMode.value).toBe(true)
      handleShortcut(key({ key: 'µ', code: 'KeyM', metaKey: true, altKey: true }))
      expect(sourceMode.value).toBe(false)
    })

    it('leaves every other Cmd+Alt combination to Vditor', () => {
      expect(handleShortcut(key({ key: 'b', code: 'KeyB', metaKey: true, altKey: true }))).toBe(false)
      expect(pendingOp.value).toBeNull()
    })
  })

  it('Cmd+\\ toggles the left panel', () => {
    handleShortcut(key({ key: '\\', metaKey: true }))
    expect(leftPanelOpen.value).toBe(false)
  })

  it('Cmd+/ toggles the right panel', () => {
    handleShortcut(key({ key: '/', metaKey: true }))
    expect(rightPanelOpen.value).toBe(true)
  })

  it('calls preventDefault on a handled key', () => {
    const e = key({ key: '2', metaKey: true })
    const spy = vi.spyOn(e, 'preventDefault')
    handleShortcut(e)
    expect(spy).toHaveBeenCalled()
  })

  it('returns false for an unhandled Cmd combination', () => {
    expect(handleShortcut(key({ key: 'q', metaKey: true }))).toBe(false)
  })
})
