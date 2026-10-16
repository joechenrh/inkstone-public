import { parserCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { Slice } from '@milkdown/kit/prose/model'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { INBOX, RESULTS } from '../../shared/live-wire.js'
import type { LiveBatch, LiveFailure, LiveOp, LiveResult } from '../../shared/live-ops.js'
import { findHeading, findText, type Hit } from './locate.js'
import type { LiveWire } from './provider.js'

/**
 * The agent's hands.
 *
 * The server cannot turn markdown into this document — see `docs/design/live-agent.md` — so a
 * connected browser does it, and this is that browser. Ops arrive in a `Y.Array`, are applied as
 * **one local transaction**, and the result goes back in a `Y.Map` for the waiting request.
 *
 * **Local, deliberately.** A local transaction enters this client's undo history, so `Cmd+Z` takes
 * back what the agent did. The cost is that the change is attributed to whoever is hosting rather
 * than to the agent, and the presence list is where the agent is visible instead. The alternative —
 * the agent as its own Yjs origin — has honest attribution and no undo at all, because
 * `y-prosemirror` tracks only `[ySyncPluginKey]` and a remote change never enters the local stack.
 *
 * **One transaction for the batch**, so a failure leaves nothing behind: an agent that cannot tell
 * whether half its edit landed has to re-read to find out, and may undo somebody else's work doing
 * it.
 */
export function serveAgent(wire: LiveWire, ctx: Ctx, view: EditorView): () => void {
  const inbox = wire.doc.getArray<LiveBatch>(INBOX)
  const results = wire.doc.getMap<LiveResult>(RESULTS)

  const run = () => {
    const batch = inbox.get(0)
    if (batch === undefined) return
    // Already answered: two clients in the room both see the inbox, and the second one must not
    // apply the batch again on top of the first one's work.
    if (results.get(batch.id) !== undefined) return

    let tr = view.state.tr
    let failure: LiveFailure | undefined

    for (const [at, op] of batch.ops.entries()) {
      // Each op is located in the document *as the previous ops left it*: a batch is a sequence,
      // and an anchor an earlier op wrote is a legitimate anchor for a later one.
      const where = locate(tr.doc, op, at)
      if ('failure' in where) { failure = where.failure; break }
      tr = write(tr, ctx, op, where.at)
    }

    if (failure === undefined && tr.docChanged) view.dispatch(tr)
    results.set(batch.id, { id: batch.id, ...(failure === undefined ? {} : { failure }) })
  }

  inbox.observe(run)
  // And once on attach: a batch may have been parked while this client was connecting.
  run()
  return () => { inbox.unobserve(run) }
}

type Located = { at: Hit } | { failure: LiveFailure }

function locate(doc: ProseNode, op: LiveOp, at: number): Located {
  if ('find' in op) return once(findText(doc, op.find), op.find, at)
  if ('insertAfterHeading' in op) {
    return once(findHeading(doc, op.insertAfterHeading), op.insertAfterHeading, at)
  }
  const end = doc.content.size
  return { at: { from: end, to: end } }
}

function once(hits: Hit[], needle: string, op: number): Located {
  if (hits.length === 0) return { failure: { kind: 'missing', op, needle } }
  if (hits.length > 1) return { failure: { kind: 'ambiguous', op, needle, matched: hits.length } }
  return { at: hits[0]! }
}

/** The replacement, parsed with the editor's own parser so it is spelled the editor's way. */
function write(tr: Transaction, ctx: Ctx, op: LiveOp, at: Hit): Transaction {
  if ('find' in op) {
    // Inline text for an inline match: parsing `replace` as a document would wrap a phrase in a
    // paragraph of its own and split the sentence it was part of.
    return tr.insertText(op.replace, at.from, at.to)
  }
  const markdown = 'insertAfterHeading' in op ? op.text : op.append
  const parsed = ctx.get(parserCtx)(markdown)
  if (parsed === null) return tr
  // After the heading's own block, or at the end of the note. An agent that means the end of a
  // section anchors on what is there.
  const where = 'insertAfterHeading' in op ? at.to : at.from
  return tr.replace(where, where, new Slice(parsed.content, 0, 0))
}
