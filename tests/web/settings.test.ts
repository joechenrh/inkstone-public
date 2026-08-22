import { beforeEach, describe, expect, it } from 'vitest'
import { editorFontSize, initSettings, readOnly, setEditorFontSize, setReadOnly, toggleReadOnly } from '../../src/web/state/settings.js'

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('style') })

describe('font size settings', () => {
  it('setEditorFontSize writes signal + CSS variable + localStorage', () => {
    setEditorFontSize(18)
    expect(editorFontSize.value).toBe(18)
    expect(document.documentElement.style.getPropertyValue('--ink-font-size')).toBe('18px')
    expect(localStorage.getItem('inkstone.editorFontSize')).toBe('18')
  })
  // The sidebar's size is not a setting: see `tokens.css`. A stored value from when it was one is
  // ignored rather than migrated — the token is a fixed 14px and nothing writes the variable.
  it('leaves the sidebar alone, whatever an old install stored', () => {
    localStorage.setItem('inkstone.treeFontSize', '16')
    initSettings()
    expect(document.documentElement.style.getPropertyValue('--ink-tree-font-size')).toBe('')
  })
  it('initSettings applies stored values', () => {
    localStorage.setItem('inkstone.editorFontSize', '14')
    initSettings()
    expect(editorFontSize.value).toBe(14)
    expect(document.documentElement.style.getPropertyValue('--ink-font-size')).toBe('14px')
  })
  it('falls back to the default for an invalid stored value', () => {
    localStorage.setItem('inkstone.editorFontSize', 'abc')
    initSettings()
    expect(editorFontSize.value).toBe(16)
  })
})

describe('read-only mode', () => {
  it('persists so a reload does not drop the reader back into an editable document', () => {
    setReadOnly(true)
    expect(readOnly.value).toBe(true)
    expect(localStorage.getItem('inkstone.readOnly')).toBe('1')
  })
  it('toggles both ways and records the off state explicitly', () => {
    setReadOnly(true)
    toggleReadOnly()
    expect(readOnly.value).toBe(false)
    // '0' rather than a removed key: an absent key is indistinguishable from never-set,
    // which is the same thing here but would stop being so if the default ever flipped.
    expect(localStorage.getItem('inkstone.readOnly')).toBe('0')
  })
})
