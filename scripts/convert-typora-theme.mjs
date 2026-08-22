#!/usr/bin/env node
/**
 * Convert a Typora theme stylesheet into an Inkstone document theme.
 *
 * Typora themes are ~60-80% ordinary document CSS. What differs is the root selector (`#write`),
 * a block of styling for Typora's own application chrome that a web app has no use for, and a set
 * of markdown-element hooks whose names are Typora's rather than Vditor's. Measured across the
 * themes we ship: 63% of selectors work after rewriting the root, 20% are chrome, 16% need mapping.
 *
 * This is deliberately not a general-purpose importer. The mapping is lossy and the proportions
 * vary a lot per theme (12% for Aspartate, 33% for Purclaude), so the output is a starting point
 * that gets read and corrected by hand, then verified by rendering it. Anything the converter is
 * unsure about it reports rather than guesses.
 *
 *   node scripts/convert-typora-theme.mjs <input.css> <theme-id> > src/web/editor/<id>-theme.css
 */
import { readFileSync } from 'node:fs'

const DOC_ROOT = '.vditor-ir .vditor-reset'

/** Typora's application chrome. None of it has an equivalent, and none of it is wanted. */
const CHROME = [
  'sidebar', 'file-node', 'file-list', 'file-library', 'context-menu', 'ty-', 'typora-sourceview',
  'md-search', 'top-titlebar', 'megamenu', 'footer-', 'toolbar', 'info-panel', 'outline',
  'md-toc', 'window-', 'quick-open', 'export-', 'form-', 'modal', 'dropdown', 'pin-outline',
  'unibody-window', 'title-bar', 'sidebar-content', 'ty-side-sort', 'searchpanel', 'ext-',
  'md-resize', 'popover', 'md-grid-board', 'auto-suggest', 'code-tooltip', 'btn', 'megamenu',
]

/**
 * Declarations that put back something the shell owns. A theme that draws its own language label
 * lands it on top of ours and on top of the copy button, and only the theme's padding decides
 * whether they collide — the same failure that made the copy button move to the top-right.
 */
const PLUMBING = [/content\s*:\s*attr\(\s*lang/i]

/**
 * Typora's markdown hooks → the Vditor DOM.
 *
 * Order matters: longer, more specific names first, so `.md-math-block` is not eaten by `.md-math`.
 * A null target means the concept has no counterpart here and the rule is dropped.
 */
const HOOKS = [
  ['.md-fences-adv', null],
  ['.md-fences', `.vditor-ir__node[data-type="code-block"] pre.vditor-ir__preview`],
  ['.md-math-block', '.vditor-ir__node[data-type="math-block"]'],
  ['.md-inline-math', '.vditor-ir__node[data-type="inline-math"]'],
  ['.md-rawblock-tooltip', null],
  ['.md-rawblock', null],
  ['.md-task-list-item', 'li'],
  ['.task-list-item', 'li'],
  ['.md-image', 'img'],
  ['.md-lang', null],       // we draw the language label ourselves, from data-lang
  ['.md-meta', null],       // Typora's syntax markers; Vditor has .vditor-ir__marker
  ['.md-plain', null],
  ['.md-comment', null],
  ['.md-attr', null],
  ['.md-critic', null],
  ['.md-blockmeta', null],
  ['.md-expand', null],
  ['.md-diagram-panel', null],
  ['.md-footnote', null],
  ['.md-def', null],
  ['.md-tag', null],
  ['.CodeMirror', null],    // Typora's source editor; we have none
]

/** Split a stylesheet into top-level blocks, honouring strings, comments and nested at-rules. */
function blocks(css) {
  const out = []
  let depth = 0, start = 0, selStart = 0
  let inString = null, inComment = false
  for (let i = 0; i < css.length; i++) {
    const c = css[i], next = css[i + 1]
    if (inComment) { if (c === '*' && next === '/') { inComment = false; i++ } continue }
    if (inString) { if (c === '\\') { i++ } else if (c === inString) inString = null; continue }
    if (c === '/' && next === '*') { inComment = true; i++; continue }
    if (c === '"' || c === "'") { inString = c; continue }
    if (c === '{') { if (depth === 0) { start = i } depth++; continue }
    if (c === '}') {
      depth--
      if (depth === 0) {
        out.push({ selector: css.slice(selStart, start).trim(), body: css.slice(start + 1, i).trim() })
        selStart = i + 1
      }
    }
  }
  return out
}

const isChrome = (sel) => CHROME.some((c) => sel.includes(c))

/** One selector: Typora's world → ours. Returns null when the rule has no home here. */
function convertSelector(sel) {
  // Comments are legal inside a selector and are whitespace to the parser, but they make the
  // output unreadable and hide what a rule actually targets.
  let s = sel.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return null
  if (isChrome(s)) return null

  for (const [from, to] of HOOKS) {
    if (!s.includes(from)) continue
    if (to === null) return null
    s = s.split(from).join(to)
  }

  // #write is Typora's document root. Alone it means the page itself.
  if (s === '#write') return DOC_ROOT
  s = s.split('#write').join(DOC_ROOT)

  // Typora hangs the page off body/html; here that is the editor surface, not the app.
  if (/^(html|body)(\s|$|\.|:|\[)/.test(s)) {
    s = s.replace(/^(html|body)/, DOC_ROOT)
  }

  // A selector that mentions the document root inside a negation is not scoped by it — it means
  // the opposite. Upstream writes `button:not(#write *)` for "every button OUTSIDE the document",
  // i.e. Typora's own chrome: Everforest painted every button in the app with !important, and the
  // whole interface turned olive. Containment has to be judged on the selector with its
  // :not()/:is()/:where() arguments removed.
  const outsideNegations = s.replace(/:(not|is|where|has)\([^()]*\)/g, '')
  if (/:(not|is|where|has)\([^()]*(#write|\.vditor-reset)[^()]*\)/.test(s) && !outsideNegations.includes(DOC_ROOT)) {
    return null
  }

  // Everything else is confined to the document. Typora themes style bare elements — `input`,
  // `table`, `a` — assuming the whole window is theirs; nested under a :root wrapper those would
  // reach the login field, the rename box and the sidebar. A theme may not style the application.
  if (!outsideNegations.includes(DOC_ROOT)) s = `${DOC_ROOT} ${s}`
  return s
}

function main() {
  const [input, id] = process.argv.slice(2)
  if (!input || !id) {
    console.error('usage: convert-typora-theme.mjs <input.css> <theme-id>')
    process.exit(2)
  }
  // Comments go first, whole-file. Upstream themes contain unterminated ones — a stray
  // `/*表格更多菜单` in Aspartate swallowed the rest of the stylesheet, and the minifier silently
  // dropped everything after it: 58 converted rules arrived in the bundle as 17. Parsing a
  // stylesheet whose comments may not close is not worth the fidelity of keeping them.
  const css = readFileSync(input, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Statement at-rules are not blocks, so they end up glued to the front of the next selector:
    // Forest's palette arrived as `@charset "UTF-8"; @import url(...); :root` and stopped being
    // recognised as a palette at all. @import also points at font files we do not vendor.
    .replace(/@(charset|import)[^;]*;/g, '')
  const notes = []
  const kept = []
  let dropped = 0, rootVars = null

  for (const { selector, body: rawBody } of blocks(css)) {
    // `rem` resolves against the root font-size, which the editor's font-size setting does not
    // touch — so every rem-based size in an upstream theme ignores the setting outright. Measured
    // before this: in four of the five converted themes the headings and the fenced block stayed
    // the same size while the body text grew from 16px to 22px. Same trap the ported Lapis hit,
    // and the reason `lapis-theme.css` writes every size as a calc against the token.
    const body = rawBody.replace(
      /(font-size:\s*)(-?[\d.]+)rem/g,
      (_, prop, n) => `${prop}calc(var(--ink-font-size, 16px) * ${n})`,
    )
    if (selector.startsWith('@')) {
      if (/^@(media\s+print|font-face|import|-webkit-keyframes|keyframes)/.test(selector)) {
        notes.push(`dropped at-rule: ${selector.slice(0, 60)}`)
        dropped++
        continue
      }
      notes.push(`kept at-rule, check by hand: ${selector.slice(0, 60)}`)
      kept.push({ selector, body })
      continue
    }
    // The theme's palette. Matched on the selector *containing* :root, not equalling it —
    // Tailwind declares its 174 variables as `:root, .md-alert`, and an equality check missed the
    // entire palette while reporting nothing wrong.
    // Declares custom properties — not merely mentions one. `html, body { background:
    // var(--bg-primary) }` contains "--" and was hoisted to the wrapper as if it were a palette,
    // so the page lost its background and its text colour in three themes at once.
    const declaresVars = /(^|;|\n)\s*--[\w-]+\s*:/.test(body)
    const isPalette = /(^|,)\s*(:root|html)\s*(,|$)/.test(selector) && declaresVars
    if (isPalette) {
      rootVars = (rootVars ?? '') + '\n' + body
      continue
    }
    if (PLUMBING.some((re) => re.test(body))) {
      notes.push(`dropped, reintroduces shell plumbing: ${selector.slice(0, 50)}`)
      dropped++
      continue
    }
    const converted = selector
      .split(',')
      .map(convertSelector)
      .filter((s) => s !== null)
    if (converted.length === 0) { dropped++; continue }
    kept.push({ selector: converted.join(',\n  '), body })
  }

  const out = []
  out.push(`/* ${id} — converted from a Typora theme by scripts/convert-typora-theme.mjs.`)
  out.push(` *`)
  out.push(` * Read before trusting: the conversion maps Typora's DOM onto Vditor's, which is lossy.`)
  out.push(` * ${kept.length} rules kept, ${dropped} dropped as Typora chrome or as concepts with no`)
  out.push(` * counterpart here. Structural plumbing (which <pre> is visible, the collapsed source,`)
  out.push(` * the copy button) belongs to vditor-shell.css and must NOT be reintroduced here — a`)
  out.push(` * theme supplies palette and typography only.`)
  out.push(` */`)
  out.push(`:root[data-doc-theme="${id}"] {`)
  if (rootVars) out.push(rootVars.split('\n').map((l) => (l.trim() ? '  ' + l.trim() : '')).join('\n'))
  for (const { selector, body } of kept) {
    out.push(`  ${selector} {`)
    out.push(body.split('\n').map((l) => (l.trim() ? '    ' + l.trim() : '')).join('\n'))
    out.push('  }')
    out.push('')
  }
  out.push('}')

  process.stdout.write(out.join('\n') + '\n')
  for (const n of notes) process.stderr.write(`note: ${n}\n`)
  process.stderr.write(`kept ${kept.length}, dropped ${dropped}\n`)
}

main()
