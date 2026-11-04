import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'

// Always create a new vault. Never point documentation captures at a configured user vault.
const root = process.cwd()
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-readme-'))
const vault = path.join(temporary, 'vault')
const output = path.join(root, 'docs/media')
await fs.mkdir(vault)
await fs.mkdir(output, { recursive: true })
const notes = {
  'Welcome.md': `# Project notebook

Notes from a small editor project. Decisions, questions, and examples live here.

## This week

- Review the keyboard shortcuts.
- Keep drafts separate from commits.
- Test editing and reading on a phone.

## Saving and history

**Save** keeps the current text. A **commit** records a version to return to.

Search works across filenames and note contents. See the [scheduler notes](Engineering/Scheduler%20notes.md) for another example.

## A small example

\`\`\`typescript
const pending = notes.filter(note => note.needsReview)
for (const note of pending) {
  await review(note)
}
\`\`\`

## Next questions

- Which details belong in a note title?
- When does a checklist become a separate document?
`,
  'Engineering/Scheduler notes.md': `# Scheduler notes

A scheduler chooses which process runs next.

## Questions

- Does this policy keep response time low?
- What happens when one task runs for a long time?

## Compare

| Policy | Useful property |
| :-- | :-- |
| Round robin | Gives each task a turn |
| Shortest job first | Favors short tasks |

Start with a small workload and record the tradeoffs.
`,
  'Engineering/Editor checklist.md': '# Editor checklist\n\n- Open a note without changing it.\n- Copy a link without changing its Markdown.\n- Try the same actions with a keyboard.\n',
  'Journal/Week 01.md': '# Week 01\n\n## Monday\n\nWrote the first project notes and made a list of questions.\n\n## Tuesday\n\nCompared two scheduling policies.\n',
  'Reading/Reading list.md': '# Reading list\n\n- Operating system scheduling\n- Plain-text note taking\n- Accessible keyboard navigation\n',
}
const git = (...args) => execFileSync('git', ['-C', vault, ...args], { stdio: 'pipe' })
git('init', '-q', '-b', 'main')
git('config', 'user.name', 'Inkstone Demo')
git('config', 'user.email', 'demo@example.com')
git('config', 'commit.gpgsign', 'false')
for (const [name, content] of Object.entries(notes)) {
  const file = path.join(vault, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}
git('add', '.')
git('commit', '-q', '-m', 'Create demo notes')
await fs.writeFile(path.join(vault, 'Welcome.md'), notes['Welcome.md'].replace('Review the keyboard shortcuts.', 'Review the editor and file-tree shortcuts.'))
git('add', 'Welcome.md')
git('commit', '-q', '-m', 'Clarify the editing checklist')

const listener = net.createServer()
listener.listen(0, '127.0.0.1')
await once(listener, 'listening')
const port = listener.address().port
await new Promise((resolve) => listener.close(resolve))
const origin = `http://127.0.0.1:${port}`
const env = { ...process.env }
for (const key of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_APP_SLUG', 'GITHUB_OWNER', 'SHARE_DIR', 'UPLOAD_DRIVER']) delete env[key]
Object.assign(env, { VAULT_ROOT: vault, AUTH_PASSWORD: 'demo-password', SESSION_SECRET: 'readme-demo-cookie-secret-local-only', LISTEN_ADDR: '127.0.0.1', PORT: String(port), INKSTONE_LIVE: '0', LOG_LEVEL: 'error' })
const server = spawn(process.execPath, ['dist/server/main.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
let browser
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Demo server did not start')), 15000)
    server.once('error', reject)
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Demo server exited (${code})`)) })
    let text = ''
    server.stdout.on('data', (chunk) => {
      text += chunk
      if (text.includes(`inkstone listening on ${origin}`)) { clearTimeout(timer); resolve() }
    })
  })
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  expect((await context.request.post(`${origin}/api/login`, { data: { password: 'demo-password' } })).ok()).toBe(true)
  const page = await context.newPage()
  await page.goto(origin)
  await page.locator('.ink-tree-name').filter({ hasText: /^Engineering$/ }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^Welcome\.md$/ }).click()
  await expect(page.locator('.ink-doc')).toContainText('Project notebook')
  await page.locator('.ink-doc p').first().click()
  await page.screenshot({ path: path.join(output, 'editor.png'), caret: 'hide' })
  // Lossless screencast frames keep small UI text sharper than transcoding browser video.
  const capture = await context.newCDPSession(page)
  const frames = []
  const writes = []
  capture.on('Page.screencastFrame', (frame) => {
    const file = path.join(temporary, `frame-${String(frames.length).padStart(4, '0')}.png`)
    frames.push({ file, at: performance.now() })
    writes.push(fs.writeFile(file, Buffer.from(frame.data, 'base64')))
    void capture.send('Page.screencastFrameAck', { sessionId: frame.sessionId })
  })
  await capture.send('Page.startScreencast', { format: 'png', maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /Markdown source/ }).click()
  await expect(page.locator('.ink-source-area')).toBeVisible()
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: /^Read \(/ }).click()
  await page.waitForTimeout(1800)
  await page.getByRole('searchbox').pressSequentially('scheduler', { delay: 85 })
  await expect(page.locator('.ink-search-hit').first()).toBeVisible()
  await page.waitForTimeout(1500)
  await page.locator('.ink-search-hit').first().click()
  await expect(page.locator('.ink-doc')).toContainText('A scheduler chooses')
  await page.waitForTimeout(1800)
  await page.getByRole('button', { name: 'Clear search' }).click()
  await page.locator('.ink-tree-name').filter({ hasText: /^Welcome\.md$/ }).click()
  await page.getByRole('button', { name: /Toggle right panel/ }).click()
  await page.locator('.ink-hist-entry').first().click()
  await expect(page.locator('.ink-hist-diff')).toBeVisible()
  await page.waitForTimeout(2200)
  await capture.send('Page.stopScreencast')
  const endedAt = performance.now()
  await Promise.all(writes)
  if (frames.length === 0) throw new Error('No screencast frames were captured')
  const sequence = path.join(temporary, 'frames.txt')
  const timeline = frames.map((frame, index) => `file '${frame.file.replaceAll("'", "'\\''")}'\nduration ${Math.max(0.001, ((frames[index + 1]?.at ?? endedAt) - frame.at) / 1000)}\n`).join('')
  await fs.writeFile(sequence, timeline + `file '${frames.at(-1).file.replaceAll("'", "'\\''")}'\n`)
  await context.close()
  const palette = path.join(temporary, 'palette.png')
  const common = ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-filter_threads', '1']
  execFileSync('ffmpeg', [...common, '-f', 'concat', '-safe', '0', '-i', sequence, '-vf', 'fps=8,scale=1100:-1:flags=lanczos,palettegen=max_colors=192:stats_mode=diff', '-frames:v', '1', palette], { stdio: 'pipe' })
  execFileSync('ffmpeg', [...common, '-filter_complex_threads', '1', '-f', 'concat', '-safe', '0', '-i', sequence, '-i', palette, '-lavfi', 'fps=8,scale=1100:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', path.join(output, 'walkthrough.gif')], { stdio: 'pipe' })
  console.log('Captured editor.png and walkthrough.gif using only synthetic demo notes.')
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
