import { expect, test } from '@playwright/test'
import { DOC_THEMES } from '../../src/web/theme/docThemes.js'

/**
 * What every document theme has to satisfy, whoever wrote it.
 *
 * Five of the seven themes are converted from Typora stylesheets, where the assumptions are
 * Typora's: its DOM, its base stylesheet, its root font size. The conversion cannot know which of
 * those assumptions a rule was leaning on, so the errors it lets through are not syntax errors —
 * they are rules that apply cleanly and lay the page out wrong. Reading the CSS does not find
 * them, and neither does looking at one theme in one appearance.
 *
 * So this measures instead: it renders one fixture holding every construct a theme was actually
 * found breaking, under every theme in both appearances, and reports every violation at once
 * rather than the first. Each rule below exists because a shipped theme broke it:
 *
 *   inline-code-size        Everforest set inline code at 100% of body, in `rem` — a size change
 *                           mid-sentence, and one that ignored the font-size setting outright.
 *   inline-code-baseline    Forest used `vertical-align: top`, hanging the pill from the top of
 *                           the line box; against CJK text the offset is plain.
 *   inline-code-fits-line   Everforest's pill was 28px in a 26px line and BitClean's 26px in 24px,
 *                           so pills in wrapped text nearly touched the row above.
 *   uniform-leading         BitClean set list items to 1.5 against 1.8 in a paragraph, Forest set
 *                           them to 1.0 inside a quote: one page reading as two documents.
 *   prose-in-normal-flow    Everforest's blockquote was `display: flex`, which laid a quote's
 *                           paragraph and its list out as two columns and broke the reading order.
 *   heading-breathing-room  Lapis left 7px under an h2 whose background is a filled pill, so the
 *                           next line looked stuck to it.
 *   list-exit-symmetry      BitClean put 32px after a list against 19px before it — leaving a list
 *                           felt like leaving a section.
 *   container-inset-symmetry BitClean's quote had 16px above its content and 35px below, a list's
 *                           bottom margin stacking onto the quote's own padding.
 *   code-block-size         A block whose code is far off the body size reads as a screenshot.
 *   table-alignment-honoured BitClean overrode `align` on every cell and Everforest and Lapis on
 *                           the header, so the toolbar's alignment buttons appeared to do nothing.
 *   table-rows-separated    A table whose rows have no border, rule or zebra fill is a wall.
 *   table-cell-padding      Text must not touch the rule beside it.
 *   table-contrast          Vditor hardcodes light row fills, which showed through in every theme
 *                           in dark — and in Aspartate, dark-only, in its one appearance.
 *   table-paints-only-its-rows  Everforest and BitClean painted ~400px of colour past the
 *                           table, where Vditor's `display: block` leaves the box wider than the rows.
 *   table-header-centred    Tailwind's header text sat 6px from the top and 12.8px from the
 *                           bottom, the top having fallen through to Vditor's default.
 *   table-rounded-corners-clean  Everforest and BitClean ran square cell borders into a rounded
 *                           table, so the grid lines were clipped part-way round the curve, and
 *                           the corner cells painted a square fill over it.
 *
 * On top of the per-render rules, each theme is re-measured at two font-size settings: `rem` is
 * root-relative and the setting is not, so four of the five converted themes kept their headings
 * and fenced blocks frozen while the body text grew. At one size a frozen theme looks perfect.
 *
 * The fixes live in `crepe-shell.css` under "the typographic bar", except where the defect was
 * one theme's alone. When this fails, fix the theme or the bar — do not widen a threshold to make
 * it pass.
 */

interface Violation { rule: string; where: string; detail: string }

// Runs in the page. Returns every violation rather than throwing on the first, so one run tells
// you everything that is wrong with a theme.
function measure(): Violation[] {
  const root = document.querySelector('.ink-doc')!
  const num = (v: string) => Math.round(parseFloat(v) * 10) / 10
  const box = (el: Element) => el.getBoundingClientRect()
  // Inline code, and only inline code: a bare `code` would also match the one inside a fenced
  // block, which the editor renders through CodeMirror.
  const inlineIn = (host: Element | null) =>
    host?.querySelector('code:not(.milkdown-code-block code)') ?? null

  const out: Violation[] = []
  const check = (rule: string, where: string, detail: string, ok: boolean) => {
    if (!ok) out.push({ rule, where, detail })
  }

  const para = root.querySelector('p')!
  const paraLeading = num(getComputedStyle(para).lineHeight) / num(getComputedStyle(para).fontSize)

  const CONTEXTS: [string, string][] = [
    ['paragraph', 'p'], ['list', 'ul li'], ['quote', 'blockquote'],
    ['quote list', 'blockquote li'], ['table', 'td'],
  ]

  for (const [where, sel] of CONTEXTS) {
    const code = inlineIn(root.querySelector(sel))
    if (!code) continue
    const ctx = code.closest('p, li, blockquote, td') ?? root
    const ccs = getComputedStyle(code)
    const pcs = getComputedStyle(ctx)
    const cf = num(ccs.fontSize)
    const pf = num(pcs.fontSize)
    const lh = num(pcs.lineHeight)
    const pill = Math.round(box(code).height)

    check('inline-code-size', where, `${cf}px in ${pf}px text (${Math.round((cf / pf) * 100)}%)`,
      cf / pf <= 0.95 && cf / pf >= 0.72)
    check('inline-code-baseline', where, `vertical-align: ${ccs.verticalAlign}`,
      ccs.verticalAlign === 'baseline')
    check('inline-code-fits-line', where, `pill ${pill}px in a ${lh}px line`, pill <= lh + 1)
  }

  // Leading is compared as a ratio, not in pixels: a theme may set a quote or a caption in a
  // smaller size and its leading should scale with it. What it may not set is a different measure.
  // Tables are excluded — a table is not running prose, and tightening one is ordinary practice.
  for (const [where, sel] of [['list item', 'ul li'], ['quote', 'blockquote p'],
    ['quote list', 'blockquote li']] as [string, string][]) {
    const el = root.querySelector(sel)
    if (!el) continue
    const cs = getComputedStyle(el)
    const ratio = num(cs.lineHeight) / num(cs.fontSize)
    check('uniform-leading', where,
      `leading ${Math.round(ratio * 100) / 100} against ${Math.round(paraLeading * 100) / 100} in a paragraph`,
      Math.abs(ratio - paraLeading) <= 0.15)
  }

  for (const [where, sel] of [['paragraph', 'p'], ['list', 'ul'], ['list item', 'ul li'],
    ['quote', 'blockquote'], ['quote list', 'blockquote ul']] as [string, string][]) {
    const el = root.querySelector(sel)
    if (!el) continue
    const cs = getComputedStyle(el)
    // `flex` is allowed on a list item and nowhere else: the editor draws one as its marker
    // beside its content, which is a row by construction. What the rule is against is a *theme*
    // laying prose out in columns — Everforest's `display: flex` on a blockquote put a quote's
    // paragraph and its list side by side and broke the reading order.
    const flow = where === 'list item'
      ? /^(block|list-item|flow-root|flex)$/
      : /^(block|list-item|flow-root)$/
    check('prose-in-normal-flow', where, `display: ${cs.display}, columns: ${cs.columnCount}`,
      flow.test(cs.display) && cs.columnCount === 'auto')
  }

  for (const tag of ['h1', 'h2']) {
    const h = root.querySelector(tag)
    if (!h) continue
    let next = h.nextElementSibling
    while (next && !box(next).height) next = next.nextElementSibling
    if (!next) continue
    const gap = Math.round(box(next).top - box(h).bottom)
    check('heading-breathing-room', tag, `${gap}px under a ${num(getComputedStyle(h).fontSize)}px heading`,
      gap >= 8)
  }

  // Entering and leaving a list should feel symmetric — a list is a continuation of the prose
  // around it, not a section of its own.
  const blocks = Array.from(root.children).filter((el) => box(el).height > 0)
  const gapAt = (i: number) => Math.round(box(blocks[i + 1]!).top - box(blocks[i]!).bottom)
  for (let i = 1; i < blocks.length - 1; i++) {
    if (blocks[i]!.tagName !== 'UL' && blocks[i]!.tagName !== 'OL') continue
    const before = gapAt(i - 1)
    const after = gapAt(i)
    check('list-exit-symmetry', blocks[i]!.tagName.toLowerCase(),
      `${after}px after the list against ${before}px before it`,
      before <= 0 || after / before <= 1.45)
  }

  // A container's padding is the space around its content; the first and last things inside it do
  // not add their own on top. BitClean's quote had 16px above its content and 35px below, the
  // surplus being a list's bottom margin, which showed as an empty band under every quote that
  // ended in a list. The tolerance is loose enough to allow a nested element's own trailing margin.
  const quote = root.querySelector('blockquote')
  if (quote) {
    const kids = Array.from(quote.children).filter((el) => box(el).height > 0)
    if (kids.length) {
      const q = box(quote)
      const top = Math.round(box(kids[0]!).top - q.top)
      const bottom = Math.round(q.bottom - box(kids[kids.length - 1]!).bottom)
      check('container-inset-symmetry', 'quote', `${top}px above the content, ${bottom}px below`,
        Math.abs(bottom - top) <= 8)
    }
  }

  // ---- tables ----------------------------------------------------------------------------
  // The one with rows in it: the editor's table block also carries a sizing table with no cells,
  // and `querySelector` finds that one first.
  const table = Array.from(root.querySelectorAll('table')).find((t) => t.rows.length > 0) ?? null
  if (table) {
    // A column's alignment is the markdown's, not the theme's. BitClean forced every cell left, so
    // alignment never showed at all; Everforest and Lapis forced the header row, so a column set to
    // right rendered a right-aligned body under a left- or centre-aligned heading. This is not a
    // style question — the toolbar's alignment buttons claim to set it.
    const want: Record<string, string> = { left: 'left', center: 'center', right: 'right' }
    for (const row of Array.from(table.rows)) {
      for (const cell of Array.from(row.cells)) {
        const attr = cell.getAttribute('align')
        if (!attr) continue
        const actual = getComputedStyle(cell).textAlign.replace('-webkit-', '')
        check('table-alignment-honoured', `r${row.rowIndex}c${cell.cellIndex}`,
          `align="${attr}" renders as ${actual}`, actual === want[attr])
      }
    }

    // Consecutive rows have to be told apart somehow. Any of the three conventions counts: a border
    // on the cells, a rule under the row (Tailwind Typography's prose tables use only this, with
    // the outer edges flush), or a zebra fill.
    const [, first, second] = Array.from(table.rows)
    if (first && second) {
      const cellBorder = parseFloat(getComputedStyle(first.cells[0]!).borderBottomWidth) > 0
      const rowBorder = parseFloat(getComputedStyle(first).borderBottomWidth) > 0
      const zebra = getComputedStyle(first).backgroundColor !== getComputedStyle(second).backgroundColor
      check('table-rows-separated', 'body', 'no cell border, row border or zebra fill',
        cellBorder || rowBorder || zebra)
    }

    // Text has to be readable on whatever is actually painted behind it. Vditor's own stylesheet
    // hardcodes `tr { background-color: #fafbfc }` and white on the alternate rows, which showed
    // through in every theme in dark — 1.2:1 in Lapis, and in Aspartate, which is dark-only, in its
    // *only* appearance. The check composites translucent layers rather than treating them as
    // opaque: a 5% white overlay on a dark page is not a white background.
    const layersBehind = (el: Element): [number, number, number] => {
      const nums = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number)
      const stack: number[][] = []
      let node: Element | null = el
      while (node) {
        const c = nums(getComputedStyle(node).backgroundColor)
        const a = c[3] ?? 1
        if (a > 0) stack.push([c[0]!, c[1]!, c[2]!, a])
        if (a >= 0.999) break
        node = node.parentElement
      }
      let out: [number, number, number] = [255, 255, 255]
      for (const [r, g, b, a] of stack.reverse()) {
        out = [r! * a! + out[0] * (1 - a!), g! * a! + out[1] * (1 - a!), b! * a! + out[2] * (1 - a!)]
      }
      return out
    }
    const luminance = ([r, g, b]: [number, number, number]) => {
      const f = (v: number) => {
        const x = v / 255
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const contrastOf = (el: Element) => {
      const nums = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number)
      const fg = nums(getComputedStyle(el).color) as [number, number, number]
      const l1 = luminance(fg)
      const l2 = luminance(layersBehind(el))
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10
    }
    for (const [where, cell] of [['header', table.rows[0]?.cells[0]],
      ['body', table.rows[1]?.cells[0]], ['zebra', table.rows[2]?.cells[0]]] as [string, Element | undefined][]) {
      if (!cell) continue
      const ratio = contrastOf(cell)
      // 4.5:1 is the readable-text bar; headers are bold and get the large-text 3:1.
      const floor = where === 'header' ? 3 : 4.5
      check('table-contrast', where, `${ratio}:1 against what is painted behind it`, ratio >= floor)
    }

    // A theme that paints the table itself must not paint past it. Vditor makes the table
    // `display: block` so a wide one can scroll, which leaves the box filling the column while the
    // rows shrink to their content — Everforest and BitClean painted ~400px of colour to the right.
    const box = table.getBoundingClientRect()
    const widest = Math.max(...Array.from(table.rows, (r) => r.getBoundingClientRect().width))
    const overhang = Math.round(box.width - widest)
    if (overhang > 4) {
      // A box wider than its rows is not itself a defect — Vditor's `display: block` gives every
      // theme one, and a table that paints nothing shows nothing. What may not happen is a theme
      // painting the difference, which is how Everforest and BitClean drew ~400px of colour beside
      // the table.
      const cs = getComputedStyle(table)
      const alpha = Number((cs.backgroundColor.match(/[\d.]+/g) ?? [])[3] ?? 1)
      const borders = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']
        .map((k) => parseFloat(cs[k as 'borderTopWidth']))
      check('table-paints-only-its-rows', 'table',
        `${overhang}px wider than its rows, painting ${cs.backgroundColor} with ${borders.join('/')} borders`,
        alpha === 0 && borders.every((w) => w === 0))
    }

    // A rounded table cannot have square cell borders running into its corners: the browser clips
    // them part-way round the curve and leaves a notch. Everforest and BitClean both did. Where the
    // table is rounded, the perimeter belongs to its own border and the cells keep only the lines
    // between them.
    const radius = parseFloat(getComputedStyle(table).borderTopLeftRadius)
    if (radius > 2) {
      const rows = Array.from(table.rows)
      const firstRow = rows[0]
      const lastRow = rows[rows.length - 1]
      const edges: [string, number][] = [
        ['top', Math.max(...Array.from(firstRow!.cells, (c) => parseFloat(getComputedStyle(c).borderTopWidth)))],
        ['bottom', Math.max(...Array.from(lastRow!.cells, (c) => parseFloat(getComputedStyle(c).borderBottomWidth)))],
        ['left', Math.max(...rows.map((r) => parseFloat(getComputedStyle(r.cells[0]!).borderLeftWidth)))],
        ['right', Math.max(...rows.map((r) => parseFloat(getComputedStyle(r.cells[r.cells.length - 1]!).borderRightWidth)))],
      ]
      for (const [side, width] of edges) {
        check('table-rounded-corners-clean', side,
          `${width}px cell border on the ${side} edge of a ${radius}px-rounded table`, width === 0)
      }
      // And the corner cells carry the radius, or their square fill paints over the curve —
      // which is what was still visible after the borders were taken off.
      const corner = parseFloat(getComputedStyle(firstRow!.cells[0]!).borderTopLeftRadius)
      check('table-rounded-corners-clean', 'corner fill',
        `corner cell is ${corner}px-rounded inside a ${radius}px-rounded table`, corner >= radius - 1)
    }

    // Header text sitting off-centre in its own row. Tailwind's upstream sets padding on three
    // sides and the fourth fell through to Vditor's default, so the header read as shifted up.
    const th = table.rows[0]?.cells[0]
    if (th) {
      const cs = getComputedStyle(th)
      const top = parseFloat(cs.paddingTop)
      const bottom = parseFloat(cs.paddingBottom)
      check('table-header-centred', 'header cell', `${top}px above the text, ${bottom}px below`,
        Math.abs(top - bottom) <= 3)
    }

    // Measured on a middle cell: the first and last are deliberately flush to the text column in
    // some themes, so their outer padding says nothing about whether text touches a rule.
    const middle = table.rows[1]?.cells[1]
    if (middle) {
      const cs = getComputedStyle(middle)
      const left = parseFloat(cs.paddingLeft)
      const right = parseFloat(cs.paddingRight)
      check('table-cell-padding', 'body cell', `${left}px / ${right}px`,
        left >= 3 && right >= 3 && Math.abs(left - right) <= 4)
    }
  }

  const blockCode = root.querySelector('pre.ink-doc code')
  if (blockCode) {
    const bf = num(getComputedStyle(blockCode).fontSize)
    const body = num(getComputedStyle(root).fontSize)
    check('code-block-size', 'fenced block', `${bf}px against ${body}px body`,
      bf / body >= 0.78 && bf / body <= 1.0)
  }

  return out
}

const format = (theme: string, appearance: string, v: Violation[]) =>
  `${theme} / ${appearance} — ${v.length} violation(s):\n` +
  v.map((x) => `  ${x.rule.padEnd(24)}${x.where.padEnd(12)}${x.detail}`).join('\n')

/**
 * Which editor these tests are about — see the same note in `smoke.spec.ts`.
 *
 * The typographic bar is measured against the rendered document, and every selector here is
 * Vditor's. The bar itself is a property of the themes and will need measuring against Crepe too,
 * which is part of what re-scoping the themes means.
 */
async function useVditor(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('inkstone.editorEngine', 'crepe')
  })
}

for (const theme of DOC_THEMES) {
  test(`${theme.name} meets the typographic bar`, async ({ page }) => {
    await useVditor(page)
    await page.goto('/')
    await page.getByPlaceholder('Password').fill('e2e-password')
    await page.getByRole('button', { name: 'Enter' }).click()
    await page.locator('.ink-tree-name').filter({ hasText: /^notes$/ }).click()
    await page.locator('.ink-tree-name').filter({ hasText: /^conformance\.md$/ }).click()
    await expect(page.locator('.ink-doc blockquote')).toBeVisible({ timeout: 15_000 })

    // A theme that ships one appearance is only ever seen in that one; forcing the other would
    // test a combination the app never renders (see clampAppearance).
    for (const appearance of theme.appearances) {
      await page.evaluate(({ id, mode }) => {
        document.documentElement.setAttribute('data-doc-theme', id)
        document.documentElement.setAttribute('data-theme', mode)
      }, { id: theme.id, mode: appearance as string })
      // The swap suppresses transitions for a frame; measure after it has settled.
      await page.waitForTimeout(150)

      const violations = await page.evaluate(measure)
      expect(violations, format(theme.name, appearance, violations)).toEqual([])

      // Everything sized by the theme has to follow the editor's font-size setting. `rem` resolves
      // against the root font-size, which the setting does not touch, so a rem-based size ignores
      // it outright: measured before this, four of the five converted themes kept their headings
      // and their fenced blocks at a fixed size while the body text grew 16px -> 22px. Checked by
      // actually changing the setting, because at one size a frozen theme looks perfect.
      const sizesAt = (px: number) => page.evaluate((value) => {
        document.documentElement.style.setProperty('--ink-font-size', `${value}px`)
        const root = document.querySelector('.ink-doc')!
        const of = (sel: string) => {
          const el = root.querySelector(sel)
          return el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10 : null
        }
        return { body: of(':scope'), h1: of('h1'), h2: of('h2'),
          block: of('.milkdown-code-block .cm-content'), quote: of('blockquote') }
      }, px)

      const small = await sizesAt(16)
      const large = await sizesAt(22)
      await page.evaluate(() => { document.documentElement.style.removeProperty('--ink-font-size') })

      const frozen = (Object.keys(small) as (keyof typeof small)[]).filter((k) => {
        const a = small[k]
        const b = large[k]
        return a !== null && b !== null && a > 0 && a === b
      })
      expect(frozen, `${theme.name} / ${appearance}: ${frozen.join(', ')} ignored the font-size ` +
        `setting — ${frozen.map((k) => `${k} stayed at ${small[k]}px`).join(', ')}`).toEqual([])
    }
  })
}
