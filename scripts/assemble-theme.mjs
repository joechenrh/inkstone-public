#!/usr/bin/env node
/**
 * Assemble a converted Typora theme into a document theme file.
 *
 * The converter handles selectors; this handles the things every conversion needs afterwards and
 * that are the same every time — they were each found by rendering Aspartate and looking:
 *
 *  - Typora themes lean on Typora's own base stylesheet for the body colour, so a conversion has
 *    none and arrives as default-coloured text on the theme's page.
 *  - The editor font-size setting names the body size. Upstream sets its own, in px or rem or a
 *    `font:` shorthand, all of which ignore the setting.
 *  - Upstream styles bare `pre` and bare `code`; in the editor's DOM those also reach the collapsed
 *    source and the <code> inside a fenced block.
 *  - highlight.js's content theme is injected at runtime and wins ties, so anything correcting it
 *    needs the `.ink-editor` prefix.
 *
 *   node scripts/assemble-theme.mjs <id> <light.css> [dark.css] > src/web/editor/<id>-theme.css
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const DOC_ROOT = '.ink-doc'

function convert(file, id) {
  const out = execFileSync('node', [path.join(here, 'convert-typora-theme.mjs'), file, id], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const open = `:root[data-doc-theme="${id}"] {`
  const body = out.slice(out.indexOf(open) + open.length).trimEnd()
  return body.endsWith('}') ? body.slice(0, -1) : body
}

const [id, lightFile, darkFile] = process.argv.slice(2)
if (!id || !lightFile) {
  console.error('usage: assemble-theme.mjs <id> <light.css> [dark.css]')
  process.exit(2)
}

const light = convert(lightFile, id)
const dark = darkFile ? convert(darkFile, id) : null

/**
 * Lift the page's own background and colour out of the converted body rule.
 *
 * highlight.js's content theme is injected into <head> at runtime and so wins ties against this
 * bundled sheet: without re-asserting them at a higher specificity, four of five themes rendered
 * with the default #24292e body text on their own page, and two kept Lapis's dark background.
 */
function pageColours(cssBody) {
  // Upstream commonly writes `html, body, #write { ... }`, which converts to three identical
  // entries in one list — so the document root is rarely the text immediately before the brace.
  // Walk every rule and take the last one whose selector list contains the bare document root.
  // Several rules can target the document root — one paints it, another sets its measure. Merge
  // across all of them, last declaration winning per property, exactly as the cascade would.
  const found = { background: null, color: null }
  for (const m of cssBody.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map((x) => x.trim()).includes(DOC_ROOT)) continue
    for (const prop of ['background-color', 'background', 'color']) {
      const d = m[2].match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))
      if (d) found[prop === 'color' ? 'color' : 'background'] = d[1].trim()
    }
  }
  return Object.entries(found)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${v};`)
}

const lightPage = pageColours(light)
const darkPage = dark ? pageColours(dark) : []

const out = []
out.push(`/* ${id} — converted from a Typora theme, then assembled by scripts/assemble-theme.mjs.`)
out.push(` *`)
out.push(` * Shell tokens are filled in from the theme's own resolved colours, so the sidebar and the`)
out.push(` * page stay one surface. Everything below the marker is the standard finishing every`)
out.push(` * conversion needs; see the script for why each line exists.`)
out.push(` */`)
out.push(`:root[data-doc-theme="${id}"] {`)
out.push('/* @shell-tokens */')
out.push(light)
if (dark) {
  out.push('')
  out.push('  /* The upstream ships its dark side as a separate file, as Typora themes do. */')
  out.push('  &[data-theme="dark"] {')
  out.push(dark.split('\n').map((l) => (l.trim() ? '  ' + l : l)).join('\n'))
  out.push('  }')
}

out.push(`
  /* ---- standard finishing ---- */

  .ink-editor .ink-doc {
    /* The setting names the body size in every theme; upstream always sets its own. */
    font-size: var(--ink-font-size, 16px);
${lightPage.map((d) => '    ' + d).join('\n')}
  }
${darkPage.length ? `
  &[data-theme="dark"] .ink-editor .ink-doc {
${darkPage.map((d) => '    ' + d).join('\n')}
  }
` : ''}

  /* Upstream draws the block's fill in whatever place Typora's DOM put it — often a bare \`code\`,
     which here is the element *inside* the pre. Rather than chase each theme's arrangement, the
     block takes the theme's own code surface, which its shell tokens already declare. */
  .ink-editor .ink-doc .milkdown-code-block {
    background: var(--ink-code-bg);
    border-radius: 6px;
    padding: 14px 16px;
  }

  /* The block's box belongs to the block, so the code inside it carries none of its own. */
  .ink-editor .ink-doc pre code {
    background: none;
    border: none;
    border-radius: 0;
    padding: 0;
    color: inherit;
  }
}`)

process.stdout.write(out.join('\n') + '\n')
