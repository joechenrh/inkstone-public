import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkstone-e2e-'))
fs.mkdirSync(path.join(root, 'notes'), { recursive: true })
fs.writeFileSync(path.join(root, 'notes', 'hello.md'), '# hello\n')
fs.writeFileSync(path.join(root, 'notes', 'welcome.md'), '# welcome\n')
fs.writeFileSync(
  path.join(root, 'notes', 'rich.md'),
  [
    '# Heading level 1',
    '',
    '## Heading level 2',
    '',
    '> A blockquote',
    '',
    'Inline `code` example',
    '',
    '- List item one',
    '- List item two',
    '',
    '```js',
    'const x = 1',
    '```',
    '',
    // Something after the fenced block, so a test can measure whether clicking the
    // block moves the document.
    'Text below the code block.',
    '',
    'A paragraph with [a link](https://example.com/docs) in it.',
    '',
    // A math block, whose source is a different height from its render — unlike a fenced
    // block, where the two are the same text over the same lines.
    '$$',
    'E = mc^2',
    '$$',
    '',
    'Text below the math block.',
    '',
  ].join('\n'),
)

// The theme-conformance fixture: every construct where a converted Typora theme was found
// breaking the line — CJK text against inline code, a wrapped list item, a list inside a quote,
// a table cell, a fenced block, and a heading with text under it.
fs.writeFileSync(
  path.join(root, 'notes', 'conformance.md'),
  [
    '# Heading one 标题',
    '',
    'Body text 正文 with `inline_code` inside it, long enough to wrap onto a second line so the',
    'leading between wrapped lines can be measured against the leading between paragraphs.',
    '',
    '## Heading two 标题',
    '',
    'Text directly under the heading, to measure the gap.',
    '',
    '- List item with `inline_code` 中文 and enough text that this item wraps onto a second line',
    '- Second item',
    '  - Nested item with `code`',
    '',
    '> A blockquote 引用 with `inline_code` in it',
    '> - a list inside the quote with `code`',
    '> - second item',
    '',
    // Explicitly aligned, so a theme overriding text-align is caught: the align attribute is
    // what lute serialises the delimiter row from, and what the table toolbar sets.
    '| Left | Centre | Right |',
    '|:---|:---:|---:|',
    '| `code` | text | 1 |',
    '| more | text | 2 |',
    '',
    '```cpp',
    'auto awaiter = GET_AWAITER(expression);',
    '```',
    '',
    'Trailing paragraph.',
    '',
  ].join('\n'),
)

// A table on its own, for the editing tests: they add and remove rows and columns, so they must
// not share a file with the conformance fixture, whose shape other tests assert.
fs.writeFileSync(
  path.join(root, 'notes', 'grid.md'),
  ['Before.', '', '| Left | Centre | Right |', '|:---|:---:|---:|',
   '| a | b | c |', '| d | e | f |', '', 'After.', ''].join('\n'),
)

// The same table again, for the other engine's suite. One file per suite, because these tests save:
// the two ran in the same file and the first to write left the second reading a table it had
// changed, which failed as a bug in the bar rather than as what it was.
fs.writeFileSync(
  path.join(root, 'notes', 'grid-crepe.md'),
  ['Before.', '', '| Left | Centre | Right |', '|:---|:---:|---:|',
   '| a | b | c |', '| d | e | f |', '', 'After.', ''].join('\n'),
)

// One note per engine for the picture tests: they paste and save, so a shared fixture would have
// each suite reading a file the other had changed.
for (const name of ['picture', 'picture-crepe']) {
  fs.writeFileSync(path.join(root, 'notes', `${name}.md`), 'Before.\n\nAfter.\n')
}

// Every inline mark and a heading. The marker tests drive a caret through all of them and save, so
// this note is theirs alone — and it holds nothing whose spelling a save would change, because one
// of those tests asserts the file is byte-identical afterwards.
fs.writeFileSync(
  path.join(root, 'notes', 'marks-crepe.md'),
  [
    '# Heading one',
    '',
    '## Heading two',
    '',
    'A paragraph with **bold text** and *italic text* and ~~struck out~~ and `inline code` in it.',
    '',
  ].join('\n'),
)

// Every pair of walls, in one note: table–table, table–fence, fence–table, and an empty table.
// A wall is a block that fills its own line and has nowhere to stand beside it; the keystrokes
// these exercise only exist there.
fs.writeFileSync(
  path.join(root, 'notes', 'walls-crepe.md'),
  [
    '| a | b |', '| - | - |', '| 1 | 2 |', '',
    '| c | d |', '| - | - |', '| 3 | 4 |', '',
    '```js', 'const x = 1', '```', '',
    '| e | f |', '| - | - |', '| 5 | 6 |', '',
    '|  |  |', '| - | - |', '|  |  |', '',
    'After.', '',
  ].join('\n'),
)

// Links between notes: one note points at another in a sibling directory, at a heading in itself,
// and at two things that are not there. The second lives one level down so a relative path has
// something to resolve against.
fs.mkdirSync(path.join(root, 'notes', 'linked'), { recursive: true })
fs.writeFileSync(
  path.join(root, 'notes', 'links.md'),
  [
    '# Links one',
    '',
    'Go to [the target](linked/target.md) for the rest.',
    '',
    'Or to [a heading in it](linked/target.md#the-numbers).',
    '',
    'Back up to [the top](#links-one) of this one.',
    '',
    'And [nowhere](linked/missing.md), and [no heading](#not-a-heading).',
    '',
    'And [the outside](https://example.com/docs).',
    '',
  ].join('\n'),
)
fs.writeFileSync(
  path.join(root, 'notes', 'linked', 'target.md'),
  ['# The target', '', 'Body of the target note.', '', '## The numbers', '',
   'Something to scroll to.', '', ...Array.from({ length: 40 }, () => 'Filler line.\n'),
  ].join('\n'),
)

// A note that holds a hard break, for the tests that this engine could not.
fs.writeFileSync(
  path.join(root, 'notes', 'breaks.md'),
  ['A\\', 'B', '', 'This paragraph holds the caret for the tests.', '', 'And a third.', ''].join('\n'),
)

// GitHub's five alerts, a plain quote, and two near-misses — a marker that is not one of the five
// and one that is not the first line. Both of those stay quotes, because that is what github.com
// does with them and these notes are read there.
fs.writeFileSync(
  path.join(root, 'notes', 'alerts.md'),
  [
    '# Alerts',
    '',
    '> [!NOTE]', '> Useful information that users should know.', '',
    '> [!TIP]', '> Helpful advice.', '',
    '> [!IMPORTANT]', '> Key information.', '',
    '> [!WARNING]', '> Urgent info.', '',
    '> [!CAUTION]', '> Risks.', '',
    '> A plain quote.', '',
    '> [!HINT]', '> Not one of the five.', '',
  ].join('\n'),
)

// A wall with nothing at all before it, which is the same problem with one side missing.
fs.writeFileSync(
  path.join(root, 'notes', 'topwall-crepe.md'),
  ['```js', 'first = 1', '```', '', 'After.', ''].join('\n'),
)

// One line with a code run and an emphasis run in it, for walking a caret through the syntax. One
// copy per test: each of them types into it, and they are about where what was typed landed.
for (const n of [1, 2, 3, 4]) {
  fs.writeFileSync(path.join(root, 'notes', `steps${n}-crepe.md`), 'x `a`+ *b*\n')
}

// A shortcode already in a file, which must survive being opened and saved.
fs.writeFileSync(path.join(root, 'notes', 'emoji-crepe.md'), 'An existing :smile: stays.\n')

// Thirty paragraphs, so that "where you were" is somewhere a scroll away from the top.
fs.writeFileSync(
  path.join(root, 'notes', 'long-crepe.md'),
  Array.from({ length: 30 }, (_, i) => `Paragraph number ${i + 1} with some words in it.`).join('\n\n') + '\n',
)

// A diagram and a formula, the two languages whose fenced block draws something.
fs.writeFileSync(
  path.join(root, 'notes', 'diagram-crepe.md'),
  ['Before.', '', '```mermaid', 'graph TD', '  A-->B', '```', '', '```js', 'const x = 1', '```', '', 'After.', ''].join('\n'),
)

// A quote against a fence and a quote against a quote: the two pairs with no position between
// them that the first version of the wall rule did not cover.
fs.writeFileSync(
  path.join(root, 'notes', 'quotewall-crepe.md'),
  ['> quoted line', '', '```js', 'const x = 1', '```', '', '> another quote', '', 'After.', ''].join('\n'),
)

// A quote and a fence to unwrap with Backspace, each with two lines in it so that what comes out
// can be seen to be all of it.
fs.writeFileSync(
  path.join(root, 'notes', 'unwrap-crepe.md'),
  ['> first quoted line', '>', '> second quoted line', '', '```js', 'const x = 1', 'const y = 2', '```', '', 'After.', ''].join('\n'),
)

// A heading, a paragraph, a fence and a table: the four places the heading keys have to answer
// differently. Its own note, because the tests change the block types in it.
fs.writeFileSync(
  path.join(root, 'notes', 'headings-crepe.md'),
  ['### Three', '', 'A plain paragraph.', '', '```js', 'const x = 1', '```', '',
   '| a | b |', '| - | - |', '| 1 | 2 |', ''].join('\n'),
)

// Two tables against each other, for the line that can be opened between them and taken back. Its
// own note: the tests above write into `walls-crepe.md`, so by the time this one ran there was
// already a paragraph where it was about to make one.
fs.writeFileSync(
  path.join(root, 'notes', 'walls2-crepe.md'),
  ['| a | b |', '| - | - |', '| 1 | 2 |', '', '| c | d |', '| - | - |', '| 3 | 4 |', '', 'After.', ''].join('\n'),
)

// A table with nothing in it, for deleting from a cell that is not the top-left one.
fs.writeFileSync(
  path.join(root, 'notes', 'emptytable-crepe.md'),
  ['|   |', '| - |', '|   |', '|   |', '|   |', '', 'After.', ''].join('\n'),
)

// A code run with text after it, for backspacing from the end of the line into it.
fs.writeFileSync(path.join(root, 'notes', 'deltail-crepe.md'), '`aaa`111\n')

// A code run to take a marker out of.
fs.writeFileSync(path.join(root, 'notes', 'damage-crepe.md'), 'x `aaa` end\n')

// A fence marked with a language, for what CodeMirror does while you type in one.
fs.writeFileSync(
  path.join(root, 'notes', 'fence-crepe.md'),
  ['```js', 'const x = 1', '```', '', 'After.', ''].join('\n'),
)

// An inline code run with text on both sides of it, for the caret at its ends. Its own note
// because the test types into it.
fs.writeFileSync(
  path.join(root, 'notes', 'tailcode-crepe.md'),
  'Tail code `a` and more\n',
)

// A note that opens with a quote, and a paragraph under it. A quote is not a wall — its lines hold
// an ordinary caret — but the first line of one at the top of a note has nothing above it either.
fs.writeFileSync(
  path.join(root, 'notes', 'topquote-crepe.md'),
  ['> A quote at the very top.', '>', '> And a second line of it.', '', 'After.', ''].join('\n'),
)

// Maths, inline and as a block, with a fence under it: the fence is there because the block is
// rendered by the same component and only the one with a formula in it collapses to its preview.
fs.writeFileSync(
  path.join(root, 'notes', 'math-crepe.md'),
  ['Inline $E=mc^2$ here.', '', '$$', '\\int_0^1 x\\,dx = \\frac{1}{2}', '$$', '', '```js', 'const x = 1', '```', ''].join('\n'),
)

// Deliberately tight markdown: lute rewrites a table the moment the rendered view is edited, so
// this is what source mode must show and preserve when it is the only thing that touched the file.
fs.writeFileSync(
  path.join(root, 'notes', 'tight.md'),
  ['Before.', '', '|Left|Centre|', '|:-|:-:|', '|a|b|', '', 'After.', ''].join('\n'),
)

const runGit = (args) => execFileSync('git', args, { cwd: root })
runGit(['init', '--initial-branch=main'])
runGit(['config', 'user.email', 'e2e@example.com'])
runGit(['config', 'user.name', 'E2E'])
runGit(['add', '.'])
runGit(['commit', '-m', 'initial'])

// These tests are about vault mode, and the server reads its mode from the environment. A shell
// that exports the GitHub App's credentials — a developer's own, quite reasonably — would
// otherwise put the server in github mode and serve a sign-in screen to every test that is
// waiting for a password field. Pinning the mode here is the only way the suite can be about what
// it says it is about.
delete process.env.GITHUB_CLIENT_ID
delete process.env.GITHUB_CLIENT_SECRET
delete process.env.GITHUB_APP_SLUG

process.env.VAULT_ROOT = root
process.env.AUTH_PASSWORD = 'e2e-password'
process.env.SESSION_SECRET = 'e2e-session-secret'
process.env.PORT = '7699'
process.env.LISTEN_ADDR = '127.0.0.1'

await import('../../dist/server/main.js')
