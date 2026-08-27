/**
 * `mermaid` fences on the reader's page, drawn.
 *
 * The editor draws them through Crepe's preview panel (`mermaid-preview.ts`); this page has no
 * editor, so it finds the fences in the rendered HTML and replaces each with its picture. Mermaid
 * is imported only when a page actually has one — it is 644 KB, larger than everything else here
 * put together, and most notes have no diagram in them.
 *
 * A diagram that does not parse is left as the code it was. On a page nobody can edit, showing the
 * source is the only useful thing left to do with it.
 */
export async function drawDiagrams(host: HTMLElement): Promise<void> {
  const fences = Array.from(host.querySelectorAll('pre > code.language-mermaid'))
  if (fences.length === 0) return

  const mermaid = (await import('mermaid')).default
  mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' })

  await Promise.all(fences.map(async (fence, index) => {
    const source = fence.textContent ?? ''
    const block = fence.parentElement
    if (block === null || source.trim() === '') return
    try {
      const { svg } = await mermaid.render(`ink-shared-diagram-${index}`, source)
      const box = document.createElement('div')
      box.className = 'ink-mermaid'
      box.innerHTML = svg
      block.replaceWith(box)
    } catch { /* left as the code it was */ }
  }))
}
