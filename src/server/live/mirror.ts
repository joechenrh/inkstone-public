import * as Y from 'yjs'
import { CLAIMS, INBOX, MIRROR, RESULTS } from '../../shared/live-wire.js'
import type { LiveBatch, LiveResult } from '../../shared/live-ops.js'

export { CLAIMS, INBOX, MIRROR, RESULTS } from '../../shared/live-wire.js'

/**
 * The server's whole view of a session's text, and the only way it reaches one.
 *
 * A session's document is a Yjs `XmlFragment` that needs a ProseMirror schema to read, and putting
 * that schema here would mean Milkdown in Node and a second markdown dialect — the one risk
 * `docs/design/live-agent.md` refuses to take. So a client keeps a plain `Y.Text` of the note's
 * markdown beside the document, and this reads *that*: no schema, no parser, no serialiser.
 *
 * The cost is that writing needs a client, which is what `submit` is: the batch is parked where a
 * browser will see it, and the answer comes back from the browser that applied it.
 */

export interface Mirror {
  text: () => string
  version: () => number
  /** Park a batch for a client to apply, and wait for its result. */
  submit: (batch: LiveBatch, waitMs: number) => Promise<LiveResult | 'timeout'>
  stop: () => void
}

export function watchMirror(doc: Y.Doc): Mirror {
  const text = doc.getText(MIRROR)
  const results = doc.getMap<LiveResult>(RESULTS)
  const inbox = doc.getArray<LiveBatch>(INBOX)
  const claims = doc.getMap<number>(CLAIMS)

  /*
   * Counted, not derived from the text.
   *
   * A hash of the markdown would be equal again after a change that undid itself, so an agent
   * holding a version from before both would be told its edit was safe. A counter only ever moves
   * forward, which is the only property a conditional edit needs.
   */
  let version = 0
  const onText = () => { version += 1 }
  text.observe(onText)

  return {
    text: () => text.toString(),
    version: () => version,

    submit: async (batch, waitMs) => await new Promise<LiveResult | 'timeout'>((resolve) => {
      let settled = false

      function onResult(): void {
        const found = results.get(batch.id)
        if (found !== undefined) finish(found)
      }

      function finish(answer: LiveResult | 'timeout'): void {
        if (settled) return
        settled = true
        results.unobserve(onResult)
        clearTimeout(timer)
        results.delete(batch.id)
        claims.delete(batch.id)
        /*
         * The batch goes either way.
         *
         * One nobody removed is applied again the next time a client syncs the room — including a
         * client that joins tomorrow — and after a timeout there is nobody waiting for the answer
         * anyway. An edit that lands twice is worse than an edit that did not land.
         */
        const at = inbox.toArray().findIndex((one) => one.id === batch.id)
        if (at >= 0) inbox.delete(at, 1)
        resolve(answer)
      }

      results.observe(onResult)
      const timer = setTimeout(() => { finish('timeout') }, waitMs)
      inbox.push([batch])
    }),

    stop: () => { text.unobserve(onText) },
  }
}
