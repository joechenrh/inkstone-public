import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { drawDiagrams } from './diagrams.js'

/**
 * Markdown to HTML for the reader's page.
 *
 * This used to be `vditor/dist/method.js` — the rendering half of the editor that is being retired
 * — and replacing it is what let the whole dependency go, its 23 MB of runtime assets with it. The
 * pipeline here is the *same parser the editor uses*: `remark-parse` with gfm and math is what
 * Milkdown reads a note with, so a shared link and the editor now agree about what the markdown
 * means rather than agreeing by coincidence. That was never true of Lute and remark.
 *
 * **Measured, because the reader pays for it, and split for the same reason.** The old path
 * fetched `method.min.js` (45 KB) and then, for any note with a fence in it, Vditor's
 * `highlight.min.js` — **1,024 KB**, every language it knows. Highlighting and maths are the two
 * expensive parts here as well, so neither is in the page's own chunk: a note is looked at first,
 * and each is fetched only if the note actually contains one. Prose, which is most shared notes,
 * pays for neither.
 *
 * **Raw HTML in a note is not rendered.** `remark-rehype` drops it unless asked, and it is not
 * asked: a shared link is a public page and the note behind it may have been written anywhere. The
 * editor shows raw HTML as text too, so this is also what the author saw.
 */
/** A fence, or an indented block. Cheap, and wrong only in the direction of fetching too much. */
const HAS_CODE = /(^|\n)\s*(```|~~~)|(^|\n) {4}\S/
/** A pair of dollars on one line, or a `$$` block: the same shapes the editor treats as maths. */
const HAS_MATH = /\$\$|\$[^\s$][^$\n]*\$/

export async function renderMarkdown(host: HTMLElement, markdown: string): Promise<void> {
  let pipeline = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype)

  if (HAS_MATH.test(markdown)) {
    const { default: rehypeKatex } = await import('rehype-katex')
    pipeline = pipeline.use(rehypeKatex)
  }
  if (HAS_CODE.test(markdown)) {
    const { default: rehypeHighlight } = await import('rehype-highlight')
    pipeline = pipeline.use(rehypeHighlight, { detect: false, ignoreMissing: true })
  }

  const file = await pipeline.use(rehypeStringify).process(markdown)
  host.innerHTML = String(file)
  // Diagrams are drawn after the HTML is in place, and only if there are any: mermaid is larger
  // than everything else on this page put together.
  await drawDiagrams(host)
}
