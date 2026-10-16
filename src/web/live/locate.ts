import type { Node as ProseNode } from '@milkdown/kit/prose/model'

/**
 * Where an agent's op lands.
 *
 * Separated from applying it because this half is the half with rules in it, and the rules are
 * promises the API makes: a match spans inline marks, it never crosses a block boundary, and
 * anything other than exactly one hit is reported rather than guessed at. All three are testable
 * without an editor — `prosemirror-model` is pure JavaScript — and none of them is obvious enough
 * to leave to an end-to-end test. See `docs/design/live-agent.md`.
 */

export interface Hit {
  from: number
  to: number
}

/**
 * Every place `needle` appears, in document positions.
 *
 * Block by block, which is what keeps a match from crossing one: the text of a block is its inline
 * content with the marks ignored, so `**bold**` inside a sentence does not break a phrase in two —
 * what a reader sees as one phrase is one phrase. Two blocks are never joined, so a needle with a
 * paragraph break in it matches nothing, which is the honest answer rather than a guess about
 * which block was meant.
 *
 * An atom inside a block — an image, a formula — reads as one object character, so a needle cannot
 * match across one either.
 */
export function findText(doc: ProseNode, needle: string): Hit[] {
  const hits: Hit[] = []
  if (needle === '') return hits
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const text = node.textBetween(0, node.content.size, undefined, '￼')
    let at = text.indexOf(needle)
    while (at >= 0) {
      // +1 for the block's own opening token: inline offset 0 is one past the node's position.
      hits.push({ from: pos + 1 + at, to: pos + 1 + at + needle.length })
      at = text.indexOf(needle, at + 1)
    }
    return false
  })
  return hits
}

/**
 * Every heading whose text is exactly `text`, at any level.
 *
 * A paragraph that happens to say the same thing is not a heading: an agent anchoring on a heading
 * means the structure, not the words, and matching the sentence under it would insert in the wrong
 * place while reporting success.
 */
export function findHeading(doc: ProseNode, text: string): Hit[] {
  const hits: Hit[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true
    if (node.textContent === text) hits.push({ from: pos, to: pos + node.nodeSize })
    return false
  })
  return hits
}
