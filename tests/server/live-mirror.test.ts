import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { INBOX, MIRROR, RESULTS, watchMirror } from '../../src/server/live/mirror.js'
import type { LiveResult } from '../../src/shared/live-ops.js'

/**
 * The server's whole view of a session's text.
 *
 * It reads a `Y.Text` and counts its changes; it never parses the document. These tests are a bare
 * `Y.Doc` standing in for a browser, which is exactly what the server cannot tell apart — if any of
 * this needed a schema, none of it would work here.
 */
describe('the mirror', () => {
  it('is empty and version zero before a client has written one', () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)
    expect(mirror.text()).toBe('')
    expect(mirror.version()).toBe(0)
    mirror.stop()
  })

  it('reads what a client wrote, with no schema anywhere', () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)
    doc.getText(MIRROR).insert(0, '# Weekly\n\n- one\n')
    expect(mirror.text()).toBe('# Weekly\n\n- one\n')
    mirror.stop()
  })

  it('counts a version per change, so an edit can be made conditional', () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)
    doc.getText(MIRROR).insert(0, 'a')
    doc.getText(MIRROR).insert(1, 'b')
    expect(mirror.version()).toBe(2)
    mirror.stop()
  })

  it('counts forward through a change that undid itself, which a hash would not', () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)
    doc.getText(MIRROR).insert(0, 'typo')
    doc.getText(MIRROR).delete(0, 4)
    // Same text as the start, and not the same version: an agent holding 0 is holding something
    // stale, and a hash would have told it otherwise.
    expect(mirror.text()).toBe('')
    expect(mirror.version()).toBe(2)
    mirror.stop()
  })

  it('parks a batch where a client will see it, and answers with the result', async () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)

    // A client: sees the inbox, does the work, writes a result under the batch id.
    doc.getArray(INBOX).observe(() => {
      const batch = doc.getArray(INBOX).get(0) as { id: string } | undefined
      if (batch === undefined) return
      doc.getText(MIRROR).insert(0, 'done')
      doc.getMap(RESULTS).set(batch.id, { id: batch.id } satisfies LiveResult)
    })

    const answer = await mirror.submit({ id: 'b1', ops: [{ append: 'x' }] }, 1000)
    expect(answer).toEqual({ id: 'b1' })
    // The version is the server's own count of the mirror, not something the browser reported.
    expect(mirror.version()).toBe(1)
    // And the inbox is left clean: a batch nobody removed is applied again by the next client to
    // sync the room.
    expect(doc.getArray(INBOX).length).toBe(0)
    mirror.stop()
  })

  it('carries a failure back rather than swallowing it', async () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)
    doc.getArray(INBOX).observe(() => {
      const batch = doc.getArray(INBOX).get(0) as { id: string } | undefined
      if (batch === undefined) return
      doc.getMap(RESULTS).set(batch.id, {
        id: batch.id,
        failure: { kind: 'ambiguous', op: 0, needle: '.', matched: 4 },
      } satisfies LiveResult)
    })

    const answer = await mirror.submit({ id: 'b3', ops: [{ find: '.', replace: '!' }] }, 1000)
    expect(answer).toEqual({
      id: 'b3',
      failure: { kind: 'ambiguous', op: 0, needle: '.', matched: 4 },
    })
    mirror.stop()
  })

  it('says timeout when nothing is applying, rather than hanging', async () => {
    const doc = new Y.Doc()
    const mirror = watchMirror(doc)
    expect(await mirror.submit({ id: 'b2', ops: [{ append: 'x' }] }, 30)).toBe('timeout')
    // And takes its batch back, so a client arriving later does not apply a request nobody awaits.
    expect(doc.getArray(INBOX).length).toBe(0)
    mirror.stop()
  })
})
