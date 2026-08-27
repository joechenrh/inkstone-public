import { beforeEach, describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../src/web/share/render.js'

/**
 * The reader's page renders with the editor's own parser.
 *
 * It used to render with `vditor/dist/method.js`, which is why retiring that engine meant writing
 * this. What matters here is not that the HTML matches Vditor's byte for byte — it does not — but
 * that everything a note can hold arrives as the element the document themes style, because the
 * themes are the only thing making this page look like the editor.
 */
describe('renderMarkdown', () => {
  let host: HTMLElement

  beforeEach(() => { host = document.createElement('div') })

  it('renders the ordinary shapes', async () => {
    await renderMarkdown(host, '# Title\n\nA paragraph with **bold** and `code`.\n\n- one\n- two\n')
    expect(host.querySelector('h1')?.textContent).toBe('Title')
    expect(host.querySelector('strong')?.textContent).toBe('bold')
    expect(host.querySelector('code')?.textContent).toBe('code')
    expect(host.querySelectorAll('ul > li')).toHaveLength(2)
  })

  it('renders a gfm table, a task list and a strikethrough', async () => {
    const md = ['| a | b |', '| - | - |', '| 1 | 2 |', '', '- [ ] undone', '- [x] done', '', '~~struck~~'].join('\n')
    await renderMarkdown(host, md)
    expect(host.querySelectorAll('table th')).toHaveLength(2)
    expect(host.querySelectorAll('table td')).toHaveLength(2)
    const boxes = host.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect((boxes[1] as HTMLInputElement).checked).toBe(true)
    expect(host.querySelector('del')?.textContent).toBe('struck')
  })

  it('highlights a fenced block, and says which language it was', async () => {
    await renderMarkdown(host, '```js\nconst x = 1\n```\n')
    const code = host.querySelector('pre > code')
    expect(code?.className).toContain('language-js')
    // Highlighted rather than merely wrapped: the keyword is its own element.
    expect(code?.querySelectorAll('span').length).toBeGreaterThan(0)
  })

  it('renders maths, inline and as a block', async () => {
    await renderMarkdown(host, 'Inline $E=mc^2$ here.\n\n$$\n\\int_0^1 x\n$$\n')
    expect(host.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2)
  })

  it('leaves a mermaid fence as code for the page to draw', async () => {
    await renderMarkdown(host, '```mermaid\ngraph TD\n  A-->B\n```\n')
    expect(host.querySelector('pre > code.language-mermaid')?.textContent).toContain('graph TD')
  })

  it('does not render raw HTML, because a shared link is a public page', async () => {
    await renderMarkdown(host, 'Before.\n\n<div align="center">raw</div>\n\n<script>alert(1)</script>\n')
    expect(host.querySelector('div[align="center"]')).toBeNull()
    expect(host.querySelector('script')).toBeNull()
  })

  it('renders a quote, which is what an alert is made of', async () => {
    await renderMarkdown(host, '> [!NOTE]\n> Something worth knowing.\n')
    const quote = host.querySelector('blockquote')
    expect(quote?.textContent).toContain('[!NOTE]')
    expect(quote?.textContent).toContain('Something worth knowing.')
  })
})
