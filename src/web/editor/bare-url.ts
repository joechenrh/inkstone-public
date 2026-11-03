import { linkSchema } from '@milkdown/kit/preset/commonmark'
import type { Ctx } from '@milkdown/kit/ctx'
import type { MarkSchema } from '@milkdown/kit/transformer'
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { defaultHandlers } from 'mdast-util-to-markdown'
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Mark, TagParseRule } from '@milkdown/kit/prose/model'

/**
 * A URL written as a URL, not wrapped in link syntax.
 *
 * A note containing `https://example.com/a/b?c=1` came back from a save as
 * `<https://example.com/a/b?c=1>` — angle brackets the reader never typed, added to every bare URL
 * in the note merely by opening it. The same thing happens to a URL pasted in: it arrives as text,
 * the editor links it, and the file gets the bracketed form.
 *
 * That is the serialiser being correct and unhelpful, the same shape as the backslashes in
 * `markdown-escapes.ts`: `<url>` is how markdown writes a link whose text *is* its address, and
 * `mdast-util-to-markdown` has no reason to prefer one spelling over another. The file does. These
 * notes are read on github.com and in other editors, where a bare URL is already a link, and a
 * vault kept in git should not show a diff on a line nobody edited.
 *
 * Source positions distinguish a bare URL, an angle autolink, and an explicit Markdown link.
 * That distinction lives in the mark, through collaboration and HTML copy/paste as well as saves.
 * Only a bare URL may omit its mark on the way out; [url](url) is still an explicit link. Bare
 * addresses have no underline or source reveal, and editing one updates its destination too.
 */

/**
 * Whether dropping the angle brackets round this URL is safe.
 *
 * Two things have to hold, and where either is in doubt the answer is no — the fallback is the
 * bracketed form, which is what the serialiser already writes.
 *
 * **It has to come back as the same link.** GFM's autolinking is not "any URL": it trims trailing
 * punctuation, it stops at an unbalanced `)`, and it ends an autolink at a character reference. A
 * URL that would come back shorter than it went out is a broken link in somebody's note.
 *
 * **It has to survive the text handler.** Written as text it goes through `writeWhatWasTyped`,
 * which unescapes `*`, `~`, `$`, brackets and parens — so a URL holding any of those could reparse
 * as emphasis, maths, or a link instead of as itself. Those characters are excluded rather than
 * reasoned about. `_` is allowed only between word characters, which is the one place the same
 * file leaves it unescaped, and `&` only where no character reference follows it.
 */
const SHAPE = /^https?:\/\/[A-Za-z0-9\-._:/?#@!&'+,;=%]+$/
const ENDS_WELL = /[A-Za-z0-9/]$/
const LOOSE_UNDERSCORE = /(?:^|[^\p{L}\p{N}_])_|_(?:$|[^\p{L}\p{N}_])/u
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/

export function keepsItsBareForm(url: string): boolean {
  return SHAPE.test(url)
    && ENDS_WELL.test(url)
    && !LOOSE_UNDERSCORE.test(url)
    && !ENTITY.test(url)
}

/** A link that is only its own address: `https://x` marked as a link to `https://x`, untitled. */
export function isBareUrl(text: string | null | undefined, href: unknown, title: unknown): boolean {
  if (typeof href !== 'string' || text !== href) return false
  if (title !== null && title !== undefined && title !== '') return false
  return keepsItsBareForm(href)
}

/** GFM's bare link has the same source range as its text. Brackets add characters outside it. */
export function linkSyntax(node: {
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: { type: string; position?: { start: { offset?: number }; end: { offset?: number } } }[]
}): 'bare' | 'autolink' | 'markdown' {
  const child = node.children?.length === 1 ? node.children[0] : undefined
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (child?.type !== 'text' || start === undefined || end === undefined) return 'markdown'
  if (child.position?.start.offset === start && child.position?.end.offset === end) return 'bare'
  if (child.position?.start.offset === start + 1 && child.position?.end.offset === end - 1) return 'autolink'
  return 'markdown'
}

/** Explicit [url](url) must not be shortened to <url> just because its label is its address. */
export function preserveLinkSyntax(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, (options) => ({
    ...options,
    handlers: {
      ...options.handlers,
      link(node, parent, state, info) {
        const resourceLink = state.options.resourceLink
        const safe = state.safe
        state.safe = (value, config) => {
          const written = safe.call(state, value, config)
          // These characters do not need escaping in URL destinations. Keep entity-shaped
          // ampersands protected and preserve paired backslashes representing real characters.
          return state.stack.includes('destinationRaw') || state.stack.includes('destinationLiteral')
            ? written.replace(/(?<!\\)\\&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);)/g, '&')
              .replace(/(?<!\\)\\\./g, '.')
            : written
        }
        if (node.data?.inkstoneSyntax === 'markdown') state.options.resourceLink = true
        try { return defaultHandlers.link(node, parent, state, info) }
        finally { state.options.resourceLink = resourceLink; state.safe = safe }
      },
    },
  }))
}

export const bareUrlsStayBare = linkSchema.extendSchema((prev) => (ctx: Ctx): MarkSchema => {
  const schema = prev(ctx)
  const upstream = schema.toMarkdown
  return {
    ...schema,
    attrs: { ...schema.attrs, syntax: { default: 'markdown' } },
    inclusive: false,
    parseMarkdown: {
      match: schema.parseMarkdown.match,
      runner(state, node, type) {
        state.openMark(type, { href: node.url, title: node.title, syntax: linkSyntax(node) })
        state.next(node.children)
        state.closeMark(type)
      },
    },
    toDOM(mark, inline) {
      const dom = schema.toDOM!(mark, inline) as [string, Record<string, unknown>, number]
      const { syntax: _syntax, ...attrs } = dom[1]
      return [dom[0], { ...attrs, 'data-link-syntax': mark.attrs.syntax }, 0]
    },
    parseDOM: schema.parseDOM?.map((rule) => {
      if (!rule.tag) return rule
      const tagRule = rule as TagParseRule
      return { ...tagRule, getAttrs(dom: HTMLElement) {
        const attrs = typeof tagRule.getAttrs === 'function' ? tagRule.getAttrs(dom) : tagRule.attrs
        if (attrs === false) return false
        return { ...attrs, syntax: dom.getAttribute('data-link-syntax') ?? 'markdown' }
      } }
    }),
    toMarkdown: {
      match: upstream.match,
      runner: (state, mark, node) => {
        const text = (node as { text?: string | null }).text
        if (mark.attrs.syntax === 'bare' && isBareUrl(text, mark.attrs.href, mark.attrs.title)) return
        state.withMark(mark, 'link', undefined, {
          title: mark.attrs.title,
          url: mark.attrs.href,
          data: { inkstoneSyntax: mark.attrs.syntax },
        })
      },
    },
  }
})

/** Editing a bare URL edits its destination too; named links keep their independent target. */
export const syncBareUrls = $prose((ctx) => new Plugin({
  appendTransaction(trs, _old, state) {
    if (!trs.some((tr) => tr.docChanged)) return null
    const type = linkSchema.type(ctx)
    const tr = state.tr
    state.doc.descendants((block, pos) => {
      if (!block.isTextblock) return
      const runs: { from: number; to: number; text: string; mark: Mark }[] = []
      block.forEach((node, offset) => {
        const mark = node.marks.find((m) => m.type === type && m.attrs.syntax === 'bare')
        if (!node.isText || !mark) return
        const from = pos + 1 + offset
        const last = runs[runs.length - 1]
        if (last && last.to === from && last.mark.eq(mark)) {
          last.to += node.nodeSize
          last.text += node.text
        } else runs.push({ from, to: from + node.nodeSize, text: node.text!, mark })
      })
      for (const { from, to, text, mark } of runs) {
        if (text === mark.attrs.href) continue
        tr.removeMark(from, to, mark)
        if (/^https?:\/\/\S+$/i.test(text)) {
          tr.addMark(from, to, type.create({ ...mark.attrs, href: text }))
        }
      }
      return false
    })
    return tr.docChanged ? tr.setMeta('addToHistory', false) : null
  },
}))
