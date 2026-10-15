import { randomInt } from 'node:crypto'

/**
 * Who is in which live session, and for how long.
 *
 * This is the second thing this server keeps that outlives a request, and unlike a share
 * (`share/store.ts`) it keeps **nothing on disk**. A live session is a conversation: it exists
 * while people are in it and the only lasting record of it is the commit the owner's browser makes
 * at the end. A restart ends every session, which is the honest consequence of that and is said
 * out loud in the interface rather than worked around.
 *
 * **The document is opaque here.** It is a Yjs document, and this module never asks what is in it:
 * the server merges updates and relays them, so it needs no ProseMirror schema and no Milkdown.
 * That is what makes a Node process able to host this editor's collaboration at all — see
 * `docs/design/live-share.md`. The consequence worth knowing: this server *cannot* turn a session
 * into markdown. Only a browser with the editor in it can, which is why the owner saves and why a
 * dropped session is kept rather than written out.
 *
 * **Two clocks, as sharing has two.** `graceUntil` is five minutes and covers the owner's tunnel,
 * closed lid and backgrounded phone: guests keep editing and the owner slots back in. `keepUntil`
 * is an hour, and covers the owner who is not coming back soon: no new guests, nobody editing, the
 * document held so the owner can come back, reclaim it and save. Deleting it at the end of the
 * grace period would throw away work that was really done, and the memory is a few kilobytes.
 */

/** No `i`, `l`, `o`, `0` or `1`: a link that gets read aloud. The same alphabet as a share id. */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const ID_LENGTH = 6

/** Enough for a meeting, few enough that a leaked link is not a free collaborative pastebin. */
export const MAX_GUESTS = 8
/** The owner's tunnel, lid and backgrounded phone. Guests keep editing throughout. */
export const GRACE_MS = 5 * 60 * 1000
/** After the grace period: nobody editing, the document held for the owner to come back and save. */
export const KEEP_MS = 60 * 60 * 1000
/** Nobody has touched the document. Ends the session rather than holding a room nobody is in. */
export const IDLE_MS = 30 * 60 * 1000
/** A session is a sitting, not a residence. */
export const MAX_SESSION_MS = 8 * 60 * 60 * 1000

/** Why a session is no longer running, which is the whole of what a guest gets told. */
export type LiveEnd = 'owner' | 'idle' | 'expired' | 'dropped'

export interface LiveMember {
  /** Unique within the session, and what an awareness update is attributed to. */
  readonly id: number
  readonly isOwner: boolean
}

export interface LiveSession<Doc> {
  readonly id: string
  /** The note's path in the owner's vault or repository. Shown to guests; names the commit. */
  readonly path: string
  /** The note's name, which is all a guest needs to see. */
  readonly title: string
  /** The account that started it: the only one that may end it, and the name guests are shown. */
  readonly owner: string
  /** The shared document. Opaque: this module never reads it. */
  readonly doc: Doc
  readonly startedAt: number
  members: LiveMember[]
  /** Set when the owner's connection goes; cleared when it comes back. */
  graceUntil: number | null
  /** Set when the grace period runs out: held for the owner, closed to everyone else. */
  keepUntil: number | null
  /** The last change to the document — not the last connection, which is not the same thing. */
  touchedAt: number
}

export type JoinRefusal = 'gone' | 'full' | 'held'

export interface LiveStoreDeps<Doc> {
  now: () => number
  /** Injected so the registry's own tests never need Yjs, and so a doc is made once per session. */
  makeDoc: () => Doc
}

/**
 * The sessions this server is running.
 *
 * Every method takes the clock from `deps`, so the tests drive time rather than wait for it.
 */
export class LiveStore<Doc> {
  readonly #sessions = new Map<string, LiveSession<Doc>>()
  readonly #now: () => number
  readonly #makeDoc: () => Doc
  #nextMember = 1

  constructor(deps: LiveStoreDeps<Doc>) {
    this.#now = deps.now
    this.#makeDoc = deps.makeDoc
  }

  get count(): number {
    return this.#sessions.size
  }

  /**
   * Start one, or hand back the one this account is already running for this note.
   *
   * One session per account, which is the cap that matters: the expensive thing is not the
   * document but the number of anonymous write endpoints open at once, and an owner who presses
   * the button twice means the link they already sent, not a second room.
   */
  open(input: { path: string; title: string; owner: string }): LiveSession<Doc> | 'busy' {
    const mine = this.of(input.owner)
    if (mine !== null) return mine.path === input.path ? mine : 'busy'
    const at = this.#now()
    const session: LiveSession<Doc> = {
      id: this.#id(),
      path: input.path,
      title: input.title,
      owner: input.owner,
      doc: this.#makeDoc(),
      startedAt: at,
      members: [],
      graceUntil: null,
      keepUntil: null,
      touchedAt: at,
    }
    this.#sessions.set(session.id, session)
    return session
  }

  get(id: string): LiveSession<Doc> | null {
    return this.#sessions.get(id) ?? null
  }

  /** The session this account is running, if any. */
  of(owner: string): LiveSession<Doc> | null {
    for (const session of this.#sessions.values()) {
      if (session.owner === owner) return session
    }
    return null
  }

  /**
   * Let somebody in.
   *
   * The owner is let in whatever state the session is in — reconnecting *is* the owner coming
   * back, and refusing them during their own grace period would be the one bug that makes the
   * grace period pointless.
   */
  join(id: string, as: 'owner' | 'guest'): LiveMember | JoinRefusal {
    const session = this.#sessions.get(id)
    if (session === undefined) return 'gone'
    if (as === 'owner') {
      session.graceUntil = null
      session.keepUntil = null
      const member = { id: this.#nextMember++, isOwner: true }
      // One owner connection: a second tab is the same person, and the first one's socket is
      // already gone or about to be. Dropping the record keeps `members` honest about who is here.
      session.members = session.members.filter((m) => !m.isOwner).concat(member)
      return member
    }
    if (session.keepUntil !== null) return 'held'
    if (session.members.filter((m) => !m.isOwner).length >= MAX_GUESTS) return 'full'
    const member = { id: this.#nextMember++, isOwner: false }
    session.members.push(member)
    return member
  }

  /**
   * Somebody's connection went.
   *
   * The owner leaving starts the grace period rather than ending the session: that is the whole
   * of what the answer to "my phone went into the background" is.
   */
  leave(id: string, member: LiveMember): void {
    const session = this.#sessions.get(id)
    if (session === undefined) return
    session.members = session.members.filter((m) => m.id !== member.id)
    if (member.isOwner && session.keepUntil === null) {
      session.graceUntil = this.#now() + GRACE_MS
    }
  }

  /** The document changed. Idle is measured from here, not from the last connection. */
  touch(id: string): void {
    const session = this.#sessions.get(id)
    if (session !== undefined) session.touchedAt = this.#now()
  }

  /** Stop one. Returns false when it was not running, so a second press is not an error. */
  end(id: string): boolean {
    return this.#sessions.delete(id)
  }

  /**
   * The clocks, run once.
   *
   * Returns what changed so the caller can tell the people still connected — a session that ends
   * silently is indistinguishable from a network that broke, and those deserve different sentences.
   * The caller closes the sockets; this decides.
   */
  sweep(): { held: LiveSession<Doc>[]; ended: { session: LiveSession<Doc>; why: LiveEnd }[] } {
    const now = this.#now()
    const held: LiveSession<Doc>[] = []
    const ended: { session: LiveSession<Doc>; why: LiveEnd }[] = []
    for (const session of [...this.#sessions.values()]) {
      if (session.keepUntil !== null) {
        if (now >= session.keepUntil) {
          this.#sessions.delete(session.id)
          ended.push({ session, why: 'dropped' })
        }
        continue
      }
      if (now - session.startedAt >= MAX_SESSION_MS) {
        this.#sessions.delete(session.id)
        ended.push({ session, why: 'expired' })
        continue
      }
      if (now - session.touchedAt >= IDLE_MS) {
        this.#sessions.delete(session.id)
        ended.push({ session, why: 'idle' })
        continue
      }
      if (session.graceUntil !== null && now >= session.graceUntil) {
        // Not deleted: the work is real and the owner may still come back for it. The guests go,
        // because there is nobody to save what they would write next.
        session.graceUntil = null
        session.keepUntil = now + KEEP_MS
        session.members = session.members.filter((m) => m.isOwner)
        held.push(session)
      }
    }
    return { held, ended }
  }

  #id(): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      let id = ''
      for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
      if (!this.#sessions.has(id)) return id
    }
    throw new Error('live: could not find a free id')
  }
}
