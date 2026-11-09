import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('preserves scoped syntax colours while excluding obsolete CodeMirror layout controls', () => {
  const folder = mkdtempSync(join(tmpdir(), 'inkstone-theme-converter-'))
  try {
    const file = join(folder, 'theme.css')
    writeFileSync(file, '.cm-s-inner span.cm-keyword { color: #123456; }\n'
      + '.cm-s-inner .CodeMirror-gutters { width: 80px; }\n')
    const converted = execFileSync('node', ['scripts/convert-typora-theme.mjs', file, 'test'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    expect(converted).toContain(':root[data-doc-theme="test"]')
    expect(converted).toContain('.ink-doc.ink-doc.ink-doc .cm-s-inner span.cm-keyword')
    expect(converted).toContain('color: #123456')
    expect(converted).not.toContain('CodeMirror-gutters')
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
