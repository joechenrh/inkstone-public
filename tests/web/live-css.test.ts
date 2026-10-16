import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Every class the live components use has a rule somewhere.
 *
 * Not style policing — a guard against one specific way this has gone wrong twice. `live.css` has
 * been edited by script, and a slice that took the wrong end of the file silently deleted a whole
 * group of rules: the agent token's row lost its flex, its gap and its size, so a label, a
 * credential and a button rendered as one run-on line at the body's font size. Nothing failed. It
 * was reported from a screenshot.
 *
 * A missing rule is invisible to the type checker and to every other test here, and this is the
 * cheapest thing that sees it.
 */

/** Plain paths from the repository root: this project runs under jsdom, where a file URL is not. */
const STYLESHEETS = [
  'src/web/live/live.css',
  'src/web/share/share.css',
  'src/web/share/shared.css',
  'src/web/layout/shell.css',
  'src/web/components/icons.css',
]
const COMPONENTS = 'src/web/live'

describe('the live components', () => {
  it('use no class that nothing styles', () => {
    const css = STYLESHEETS.map((at) => readFileSync(at, 'utf8')).join('\n')
    const sources = readdirSync(COMPONENTS)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => readFileSync(`${COMPONENTS}/${name}`, 'utf8'))
      .join('\n')

    /*
     * Only what a `class` attribute says.
     *
     * Every `ink-` token in the file would be simpler and is wrong: a form control's `id` and its
     * label's `for` are named the same way here, and neither is ever styled. The first run of this
     * test reported `ink-live-name` — an input's id — which is exactly the false alarm that gets a
     * guard like this deleted.
     */
    const attrs = [...sources.matchAll(/class=(?:"([^"]*)"|\{([^}]*)\})/g)]
      .map(([, quoted, braced]) => quoted ?? braced ?? '')
      .join(' ')
    const used = new Set(attrs.match(/ink-[a-z0-9-]+/g) ?? [])
    const unstyled = [...used].filter((name) => !css.includes(`.${name}`))
    expect(unstyled, 'these have no rule in any stylesheet the live components load').toEqual([])
  })
})
