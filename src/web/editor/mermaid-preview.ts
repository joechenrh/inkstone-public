import { resolvedTheme } from '../theme/useTheme.js'

/**
 * A `mermaid` fence draws its diagram.
 *
 * The one capability the other engine had that this one did not, measured rather than assumed: the
 * same note showed a diagram in Vditor and a block of `graph TD` in Crepe. Crepe's fenced block
 * already has a preview panel — the formula block is drawn through it — so this is that hook
 * answering one more language.
 *
 * **Loaded when a diagram is on screen, not before.** Mermaid is larger than the rest of the
 * editor put together; a dynamic import makes it its own chunk, so a reader who has never written
 * a diagram never fetches it.
 *
 * **A diagram that does not parse says so where it is.** Half-typed mermaid is the normal state of
 * a diagram being written, and the alternative to a message in the panel is an exception inside the
 * editor's own render.
 */

let mermaid: typeof import('mermaid').default | null = null
let seq = 0

async function load(): Promise<typeof import('mermaid').default> {
  if (mermaid === null) {
    mermaid = (await import('mermaid')).default
    mermaid.initialize({
      startOnLoad: false,
      // The document's own colours are a theme decision this does not get to make; `neutral` is
      // the one that reads as ink on paper rather than as a product's brand.
      theme: resolvedTheme.value === 'dark' ? 'dark' : 'neutral',
      securityLevel: 'strict',
      // Not `inherit`: mermaid writes this into the SVG's own inline styles, where it resolves
      // against nothing and the labels came out in a fallback face. The document's variable does
      // resolve there — the SVG is in the document — and a stack behind it covers the rest.
      fontFamily: 'var(--ink-font-body), ui-sans-serif, system-ui, sans-serif',
    })
  }
  return mermaid
}

/**
 * Somewhere with layout for mermaid to measure in.
 *
 * Without it every label came out `<foreignObject width="0" height="0">` and the letters were
 * clipped to slivers — `A` read as `∧`. Mermaid sizes each label by *rendering* it and asking the
 * browser how big it came out, and a browser answers zero for anything that is not laid out. So
 * this is off-screen rather than hidden: `display: none` would measure zero just the same.
 */
let ruler: HTMLElement | null = null

function measuringHost(): HTMLElement {
  if (ruler === null) {
    ruler = document.createElement('div')
    ruler.setAttribute('aria-hidden', 'true')
    ruler.style.cssText = 'position:absolute;left:-10000px;top:0;width:1200px;visibility:hidden'
    document.body.appendChild(ruler)
  }
  return ruler
}

function failure(message: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'ink-mermaid-error'
  box.textContent = message
  return box
}

/**
 * Crepe's `renderPreview`, for `mermaid` and nothing else.
 *
 * The two return values are a protocol, and the difference is not obvious: `null` means *there is
 * no preview* and clears the panel, `undefined` means *one is coming* and puts "Loading…" there
 * until `applyPreview` arrives. Returning `null` for a diagram threw away the render that was
 * already on its way, which looked exactly like the feature not being wired up at all.
 *
 * Every other language gets `null`, which is what the default does — the formula block's preview
 * wraps this one, so what it declines lands here and what this declines is genuinely nothing.
 */
export function renderMermaid(
  language: string,
  content: string,
  applyPreview: (value: null | string | HTMLElement) => void,
): void | null {
  if (language.trim().toLowerCase() !== 'mermaid') return null
  if (content.trim() === '') return null

  const id = `ink-mermaid-${seq++}`
  void (async () => {
    try {
      const engine = await load()
      const { svg } = await engine.render(id, content, measuringHost())
      const box = document.createElement('div')
      box.className = 'ink-mermaid'
      box.innerHTML = svg
      applyPreview(box)
    } catch (err) {
      applyPreview(failure(err instanceof Error ? err.message : 'This diagram did not parse.'))
    }
  })()
}
