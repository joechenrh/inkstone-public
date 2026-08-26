/**
 * Where you were, on the way into the source and on the way back.
 *
 * Typora keeps your place when you look at the markdown; this opened the source at character zero
 * every time, and coming back put the caret at the top of the note. In a long note that is the
 * whole cost of looking: you lose your place in both directions.
 *
 * **What is matched is the block, not the character.** The rendered document and the file do not
 * agree about offsets — `**bold**` is eight characters in one and four in the other, a table is a
 * grid here and five lines there — and any attempt to map them exactly is a second serialiser that
 * has to stay in step with the first. What both *do* agree about is the sequence of blocks: the
 * fourth paragraph is the fourth paragraph. So the caret lands on the right block, at its start,
 * which is close enough to keep your place and cannot drift into a wrong answer.
 *
 * The scanner below is the half of that which markdown owns; `caretBlockIndex` is the half the DOM
 * owns, and it works for either engine because both render a document's blocks as the children of
 * one element.
 */

const FENCE = /^\s{0,3}(```|~~~)/
const HEADING = /^\s{0,3}#{1,6}\s/
const LIST_ITEM = /^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/
const INDENTED = /^\s{2,}\S/

/**
 * The first line of every top-level block, in order.
 *
 * A blank line ends a block, except inside a fence — and except between the items of one list,
 * which is one `<ul>` on screen however much air is between its items. Everything else is the
 * ordinary reading: a fence runs to its closing fence, a heading is its own line, and consecutive
 * lines of prose, quote or table are one block each.
 */
export function blockLines(markdown: string): number[] {
  const lines = markdown.split('\n')
  const starts: number[] = []
  let fence: string | null = null
  let open = false
  let listOpen = false
  let blank = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    if (fence !== null) {
      // Inside a fence nothing separates anything; only its own closing marker ends it.
      if (line.trimStart().startsWith(fence)) { fence = null; open = false; listOpen = false }
      continue
    }

    if (line.trim() === '') { blank = true; continue }

    const fenced = FENCE.exec(line)
    if (fenced) {
      starts.push(i)
      fence = fenced[1] ?? '```'
      open = true
      listOpen = false
      blank = false
      continue
    }

    const isHeading = HEADING.test(line)
    const isList = LIST_ITEM.test(line)
    // A blank line between two list items leaves the list open — one `<ul>` on screen, however
    // much air is between its items. After any other blank line, what follows is a new block.
    const continuesList = listOpen && (isList || INDENTED.test(line))
    const continues = isHeading ? false : blank ? continuesList : (open || continuesList)

    if (!continues) {
      starts.push(i)
      open = true
      listOpen = isList
    } else if (isList) {
      listOpen = true
    }
    // A heading is one line, so whatever follows it starts something new.
    if (isHeading) { open = false; listOpen = false }
    blank = false
  }

  return starts
}

/** Which block a line is part of. Lines before the first block belong to it. */
export function blockAtLine(markdown: string, line: number): number {
  const starts = blockLines(markdown)
  let index = 0
  for (let i = 0; i < starts.length; i++) {
    if ((starts[i] ?? 0) <= line) index = i
    else break
  }
  return index
}

/** The character offset where a line starts. */
export function offsetOfLine(text: string, line: number): number {
  const lines = text.split('\n')
  let offset = 0
  for (let i = 0; i < line && i < lines.length; i++) offset += (lines[i]?.length ?? 0) + 1
  return offset
}

/** The line a character offset falls on. */
export function lineAtOffset(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split('\n').length - 1
}

/** The offset in the markdown where the nth top-level block starts. */
export function offsetOfBlock(markdown: string, index: number): number {
  const starts = blockLines(markdown)
  if (starts.length === 0) return 0
  const line = starts[Math.min(Math.max(index, 0), starts.length - 1)] ?? 0
  return offsetOfLine(markdown, line)
}

/** The index of the top-level block a character offset is in. */
export function blockAtOffset(markdown: string, offset: number): number {
  return blockAtLine(markdown, lineAtOffset(markdown, offset))
}

/** The index of the top-level block the document's caret is in, or null when it is nowhere. */
export function caretBlockIndex(root: HTMLElement): number | null {
  const selection = document.getSelection()
  const node = selection?.focusNode
  if (!node || !root.contains(node)) return null
  // Up to the child of the root: that is what "block" means here, and it is what both engines
  // render a document's blocks as.
  let candidate: Element | null = node instanceof Element ? node : node.parentElement
  while (candidate !== null && candidate.parentElement !== root) candidate = candidate.parentElement
  if (candidate === null) return null
  const at = Array.from(root.children).indexOf(candidate)
  return at < 0 ? null : at
}

/** Put the caret at the start of the nth top-level block of a rendered document. */
export function placeCaretInBlock(root: HTMLElement, index: number): boolean {
  const block = root.children[Math.min(Math.max(index, 0), root.children.length - 1)]
  if (!(block instanceof HTMLElement)) return false
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const text = walker.nextNode()
  const range = document.createRange()
  if (text) range.setStart(text, 0)
  else range.selectNodeContents(block)
  range.collapse(true)
  const selection = document.getSelection()
  if (!selection) return false
  selection.removeAllRanges()
  selection.addRange(range)
  block.scrollIntoView({ block: 'center' })
  return true
}
