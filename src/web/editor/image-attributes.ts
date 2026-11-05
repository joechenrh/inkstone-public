import { imageSchema } from '@milkdown/kit/preset/commonmark'
import type { Ctx } from '@milkdown/kit/ctx'
import type { NodeSchema } from '@milkdown/kit/transformer'
import type { TagParseRule } from '@milkdown/kit/prose/model'

/** Alt text is not a title: copying an image must not invent a tooltip in its Markdown. */
export const imageAttributes = imageSchema.extendSchema((prev) => (ctx: Ctx): NodeSchema => {
  const schema = prev(ctx)
  return { ...schema, parseDOM: schema.parseDOM?.map((rule) => {
    if (!rule.tag) return rule
    const tag = rule as TagParseRule
    return { ...tag, getAttrs(dom: HTMLElement) {
      const attrs = tag.getAttrs ? tag.getAttrs(dom) : tag.attrs
      if (attrs === false) return false
      return { ...attrs, title: dom.getAttribute('title') ?? '' }
    } }
  }) }
})
