import { describe, expect, it } from 'vitest'
import {
  GRACE_MS,
  IDLE_MS,
  KEEP_MS,
  LiveStore,
  MAX_GUESTS,
  MAX_SESSION_MS,
} from '../../src/server/live/store.js'

/**
 * The registry's clocks and caps, driven rather than waited for.
 *
 * Every rule here is a sentence somebody reads in the interface — "这场协作满了", "连接断开，正在
 * 重连", "协作已结束" — so each one is asserted on its own. The document is a plain object: this
 * registry never looks inside one, and a test that needed Yjs to say who may join would be
 * testing the wrong thing.
 */

function storeAt(start = 1_000_000) {
  let now = start
  const store = new LiveStore<{ what: string }>({
    now: () => now,
    makeDoc: () => ({ what: 'opaque' }),
  })
  return { store, at: (ms: number) => { now = start + ms }, now: () => now }
}

const NOTE = { path: 'notes/周会.md', title: '周会.md', owner: 'octocat' }

describe('a live session', () => {
  it('is opened by its owner, with nobody in it yet', () => {
    const { store } = storeAt()
    const session = store.open(NOTE)
    expect(session).not.toBe('busy')
    if (session === 'busy') return
    expect(session.id).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/)
    expect(session.members).toEqual([])
    expect(store.get(session.id)).toBe(session)
  })

  it('hands the same one back when the owner presses the button twice', () => {
    const { store } = storeAt()
    const first = store.open(NOTE)
    const again = store.open(NOTE)
    expect(again).toBe(first)
    expect(store.count).toBe(1)
  })

  it('refuses a second note while one is running: the link already sent is the session', () => {
    const { store } = storeAt()
    store.open(NOTE)
    expect(store.open({ ...NOTE, path: 'notes/别的.md', title: '别的.md' })).toBe('busy')
    expect(store.count).toBe(1)
  })

  it('is per account: two owners get two sessions', () => {
    const { store } = storeAt()
    store.open(NOTE)
    const other = store.open({ ...NOTE, owner: 'someone-else' })
    expect(other).not.toBe('busy')
    expect(store.count).toBe(2)
  })
})

describe('joining', () => {
  it('lets guests in up to the cap, and then says full', () => {
    const { store } = storeAt()
    const session = store.open(NOTE)
    if (session === 'busy') throw new Error('not opened')
    for (let i = 0; i < MAX_GUESTS; i++) {
      expect(store.join(session.id, 'guest')).toMatchObject({ isOwner: false })
    }
    expect(store.join(session.id, 'guest')).toBe('full')
  })

  it('still lets the owner in when the guests have filled it', () => {
    const { store } = storeAt()
    const session = store.open(NOTE)
    if (session === 'busy') throw new Error('not opened')
    for (let i = 0; i < MAX_GUESTS; i++) store.join(session.id, 'guest')
    expect(store.join(session.id, 'owner')).toMatchObject({ isOwner: true })
  })

  it('keeps one owner connection, not one per tab', () => {
    const { store } = storeAt()
    const session = store.open(NOTE)
    if (session === 'busy') throw new Error('not opened')
    store.join(session.id, 'owner')
    store.join(session.id, 'owner')
    expect(session.members.filter((m) => m.isOwner)).toHaveLength(1)
  })

  it('says gone for an id that is not running — the same answer for expired and never-existed', () => {
    const { store } = storeAt()
    expect(store.join('zzzzzz', 'guest')).toBe('gone')
  })
})

describe('the owner dropping', () => {
  it('starts the grace period rather than ending the session', () => {
    const { store, at } = storeAt()
    const session = store.open(NOTE)
    if (session === 'busy') throw new Error('not opened')
    const owner = store.join(session.id, 'owner')
    if (typeof owner === 'string') throw new Error('not joined')
    store.join(session.id, 'guest')

    at(1000)
    store.leave(session.id, owner)
    expect(session.graceUntil).toBe(1_000_000 + 1000 + GRACE_MS)

    // Within it, the guests are still editing and the session is still running.
    at(1000 + GRACE_MS - 1)
    expect(store.sweep().held).toEqual([])
    expect(store.get(session.id)).toBe(session)
  })

  it('is undone by coming back: the clock is cleared, not merely ignored', () => {
    const { store, at } = storeAt()
    const session = store.open(NOTE)
    if (session === 'busy') throw new Error('not opened')
    const owner = store.join(session.id, 'owner')
    if (typeof owner === 'string') throw new Error('not joined')
    store.leave(session.id, owner)
    at(GRACE_MS - 1000)
    store.join(session.id, 'owner')
    expect(session.graceUntil).toBeNull()
    at(GRACE_MS + 1000)
    expect(store.sweep().held).toEqual([])
  })

  it('holds the document for an hour once the grace period runs out, and sends the guests home', () => {
    const { store, at } = storeAt()
    const session = store.open(NOTE)
    if (session === 'busy') throw new Error('not opened')
    const owner = store.join(session.id, 'owner')
    if (typeof owner === 'string') throw new Error('not joined')
    store.join(session.id, 'guest')
    store.leave(session.id, owner)

    at(GRACE_MS)
    const swept = store.sweep()
    expect(swept.held).toEqual([session])
    expect(swept.ended).toEqual([])
    // Held, not deleted: the work is real and the owner may come back for it.
    expect(store.get(session.id)).toBe(session)
    expect(session.keepUntil).toBe(1_000_000 + GRACE_MS + KEEP_MS)
    expect(session.members.filter((m) => !m.isOwner)).toEqual([])

    // And closed to everyone but the owner.
    expect(store.join(session.id, 'guest')).toBe('held')
    expect(store.join(session.id, 'owner')).toMatchObject({ isOwner: true })
    expect(session.keepUntil).toBeNull()
  })

  it('lets the held document go after the hour', () => {
    const { store, at } = storeAt()
    const session = store.open(NOTE)
    if (session === 'busy') throw new Error('not opened')
    const owner = store.join(session.id, 'owner')
    if (typeof owner === 'string') throw new Error('not joined')
    store.leave(session.id, owner)
    at(GRACE_MS)
    store.sweep()

    at(GRACE_MS + KEEP_MS)
    expect(store.sweep().ended).toEqual([{ session, why: 'dropped' }])
    expect(store.get(session.id)).toBeNull()
  })
})

describe('the other clocks', () => {
  it('ends a session nobody has typed in for half an hour', () => {
    const { store, at } = storeAt()
    const session = store.open(NOTE)
    if (session === 'busy') throw new Error('not opened')
    store.join(session.id, 'owner')

    at(IDLE_MS - 1)
    expect(store.sweep().ended).toEqual([])
    // A connection is not a change: being in the room does not keep it open.
    at(IDLE_MS)
    expect(store.sweep().ended).toEqual([{ session, why: 'idle' }])
  })

  it('measures idle from the last change, not the last connection', () => {
    const { store, at } = storeAt()
    const session = store.open(NOTE)
    if (session === 'busy') throw new Error('not opened')
    at(IDLE_MS - 1000)
    store.touch(session.id)
    at(IDLE_MS + 1000)
    expect(store.sweep().ended).toEqual([])
  })

  it('ends a sitting that has run for eight hours, however busy it is', () => {
    const { store, at } = storeAt()
    const session = store.open(NOTE)
    if (session === 'busy') throw new Error('not opened')
    at(MAX_SESSION_MS)
    store.touch(session.id)
    expect(store.sweep().ended).toEqual([{ session, why: 'expired' }])
  })
})

describe('ending', () => {
  it('is not an error twice: a second press is the same wish', () => {
    const { store } = storeAt()
    const session = store.open(NOTE)
    if (session === 'busy') throw new Error('not opened')
    expect(store.end(session.id)).toBe(true)
    expect(store.end(session.id)).toBe(false)
    expect(store.of(NOTE.owner)).toBeNull()
  })
})
