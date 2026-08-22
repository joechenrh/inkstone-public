import { describe, expect, it } from 'vitest'
import { alertAt, ALERT_KINDS } from '../../src/web/editor/alerts.js'
import { showAlerts } from '../../src/web/editor/alert-dom.js'

/**
 * GitHub's alerts.
 *
 * The specification is somebody else's, and matching it exactly is the whole reason to implement
 * an extension rather than invent a callout: these notes are read on github.com, where anything
 * this file accepts and that renderer does not would come out as a quote with `[!HINT]` in it.
 */
describe('what counts as an alert', () => {
  it('takes the five, and says which', () => {
    for (const kind of ALERT_KINDS) {
      expect(alertAt(`[!${kind.toUpperCase()}]\nbody`)?.kind).toBe(kind)
    }
  })

  it('is uppercase only, because GitHub is', () => {
    expect(alertAt('[!Note]\nbody')).toBeNull()
    expect(alertAt('[!note]\nbody')).toBeNull()
  })

  it('takes nothing else in the brackets', () => {
    expect(alertAt('[!HINT]\nbody')).toBeNull()
    expect(alertAt('[!]\nbody')).toBeNull()
    expect(alertAt('[NOTE]\nbody')).toBeNull()
  })

  it('has to be the first line, and the whole of it', () => {
    expect(alertAt('A quote.\n[!NOTE]')).toBeNull()
    expect(alertAt('[!NOTE] and then more on the same line')).toBeNull()
    // Trailing spaces are the writer's, not a second thing on the line.
    expect(alertAt('[!TIP]   \nbody')?.kind).toBe('tip')
  })

  it('reports how much of the text it took, so a caller can cover it exactly', () => {
    expect(alertAt('[!NOTE]\nbody')?.length).toBe('[!NOTE]'.length)
    expect(alertAt('[!TIP]  \nbody')?.length).toBe('[!TIP]  '.length)
  })

  it('is an alert with nothing after it, which is a quote of one line', () => {
    expect(alertAt('[!CAUTION]')?.kind).toBe('caution')
  })
})

/**
 * The DOM half, which is what the reader page and the other engine use.
 *
 * `live: false` is the reader's setting: that page has no caret, so it never shows the syntax.
 */
describe('drawing them into a rendered document', () => {
  function render(html: string): HTMLElement {
    const root = document.createElement('div')
    root.className = 'ink-doc'
    root.innerHTML = html
    document.body.append(root)
    return root
  }

  it('tags the blockquote and hides the marker behind its label', () => {
    const root = render('<blockquote><p>[!NOTE]\nUseful information.</p></blockquote>')
    const stop = showAlerts(root, { live: false })

    const quote = root.querySelector('blockquote')!
    expect(quote.getAttribute('data-alert')).toBe('note')
    // Wrapped, not removed: the text is really there and has to come back for the caret.
    const marker = quote.querySelector('.ink-alert-marker')
    expect(marker?.textContent).toBe('[!NOTE]\n')
    // The line break went in with it — hidden on its own the marker leaves an empty first line.
    expect(quote.textContent).toBe('[!NOTE]\nUseful information.')

    stop()
    root.remove()
  })

  it('leaves a plain quote and a marker that is not one of the five alone', () => {
    const root = render(
      '<blockquote><p>A plain quote.</p></blockquote>'
      + '<blockquote><p>[!HINT]\nNot one of the five.</p></blockquote>'
      + '<blockquote><p>A quote.\n[!NOTE] not the first line.</p></blockquote>',
    )
    const stop = showAlerts(root, { live: false })

    for (const quote of Array.from(root.querySelectorAll('blockquote'))) {
      expect(quote.getAttribute('data-alert')).toBeNull()
      expect(quote.querySelector('.ink-alert-marker')).toBeNull()
    }
    stop()
    root.remove()
  })

  it('takes the tag off again when the marker is edited away', async () => {
    const root = render('<blockquote><p>[!NOTE]\nUseful information.</p></blockquote>')
    const stop = showAlerts(root, { live: false })
    const quote = root.querySelector('blockquote')!
    expect(quote.getAttribute('data-alert')).toBe('note')

    quote.querySelector('p')!.textContent = 'Just a quote now.'
    await new Promise((r) => requestAnimationFrame(() => { r(null) }))

    expect(quote.getAttribute('data-alert')).toBeNull()
    stop()
    root.remove()
  })
})
