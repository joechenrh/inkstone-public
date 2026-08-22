import { emphasisSchema, strongSchema } from '@milkdown/kit/preset/commonmark'
import { strikethroughSchema } from '@milkdown/kit/preset/gfm'
import type { Ctx } from '@milkdown/kit/ctx'
import type { MarkSchema } from '@milkdown/kit/transformer'

/**
 * A run of emphasis ends where its closing `*` is.
 *
 * ProseMirror calls a mark *inclusive* when the position at the end of a run still belongs to it,
 * and emphasis, strong and strikethrough all are by default. In a word processor that is right:
 * there is no closing marker, so the end of the bold text is the only place the caret can be and
 * carrying on typing should carry on being bold.
 *
 * In markdown there is a closing marker, and the position after it is a different place — the one a
 * click past the end of the line means. Left inclusive, that place could not be reached: whatever
 * was typed at the end of `*b*` came out italic, and there was no way to stop. Reported as exactly
 * that.
 *
 * Inline code is already not inclusive, which is why the same report had a second half — a code run
 * that could never be added to. Both halves are the same missing thing, and the answer is not to
 * make every mark behave one way but to let the caret say which side of the marker it is on: see
 * `mark-step.ts`. This file only sets what arriving somewhere *without* saying anything means, and
 * the honest default is the source position, which is outside.
 */
const outside = (prev: (ctx: Ctx) => MarkSchema) =>
  (ctx: Ctx): MarkSchema => ({ ...prev(ctx), inclusive: false })

export const marksEndAtTheirMarker = [
  strongSchema.extendSchema(outside),
  emphasisSchema.extendSchema(outside),
  strikethroughSchema.extendSchema(outside),
]
