import { randomInt } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { FONT_WEIGHTS, type FontWeight } from './font.js'

/**
 * Where a shared note lives, and for how long.
 *
 * This is the first state this server has ever kept that outlives a request, and the design record
 * (`docs/design/sharing.md`) argues why that is payable rather than a contradiction: a private note
 * never comes here, and pressing Share is choosing to publish one.
 *
 * **No database.** Two files per share in one directory — `<id>.json` for the facts and `<id>.md`
 * for the text — which is the same shape as everything else this server keeps. The metadata is
 * indexed in memory at startup so a share, an extend and a cap check never read the notes
 * themselves; the text is only ever touched when someone actually asks for it.
 */

/** Long enough to be unguessable, short enough to paste. 31^6 ≈ 887 million. */
const ID_LENGTH = 6
/**
 * A picture's name, as the vault and the repository both spell it: the hash of its own bytes.
 *
 * Checked rather than sanitised, and checked in two places. This one builds a path out of a name
 * that arrived over the network, and there is no version of that which is safe by inspection.
 */
const SAFE_ASSET = /^[a-f0-9]{16}\.(?:webp|png|jpe?g|gif|avif)$/

/** No `i`, `l`, `o`, `0` or `1`: this ends up read aloud and retyped. */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export const MAX_CONTENT_BYTES = 64 * 1024
/**
 * How many bytes of pictures one shared note may carry.
 *
 * A copy, like the text: the note goes on changing after it is shared and this does not. The number
 * is what the re-encoder makes plausible — a screenshot comes to 9–35 KB — so this is room for a
 * note full of them and a refusal for one carrying something that was never re-encoded. It also
 * bounds what a public link can cost on a pay-by-traffic line.
 */
export const MAX_SHARE_ASSET_BYTES = 4 * 1024 * 1024
export const MAX_PER_ACCOUNT = 20
export const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long the record outlives the note.
 *
 * Deleting an expired share outright would make it indistinguishable from a link that never
 * existed, and those deserve different sentences — see `ShareRead`. So the text goes at expiry and
 * a few hundred bytes stay until this second clock runs out, which is what keeps the directory
 * bounded rather than merely slow-growing.
 */
export const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000

export interface ShareMeta {
  id: string
  /** GitHub's numeric user id. The key, because a login can be changed and reused. */
  ownerId: number
  /** Kept only so an operator reading the directory can tell whose share this is. */
  ownerLogin: string
  /** `owner/name`, so re-sharing the same path in a different repository is a different share. */
  repo: string
  path: string
  /** What the reader's tab says. Derived by the client from the note, not from the path. */
  title: string
  createdAt: number
  expiresAt: number
  purgeAt: number
  /** The sharer stopped it. The record stays until `purgeAt` so the reader gets told which. */
  stopped: boolean
}

export type ShareRead =
  | { ok: true; meta: ShareMeta; content: string }
  | { ok: false; reason: 'missing' | 'expired' | 'stopped' }

export interface ShareInput {
  ownerId: number
  ownerLogin: string
  repo: string
  path: string
  title: string
  content: string
  /**
   * A CJK face cut down to this note's own characters, or null when it needs none.
   *
   * Stored beside the note because it belongs to it: it is regenerated whenever the text changes,
   * and it goes when the note goes. See `font.ts` for why a shared note does not simply use the
   * one the app ships.
   */
  fonts?: Record<FontWeight, Buffer> | null
  /**
   * The pictures the note refers to, by the name it refers to them by.
   *
   * Copied rather than linked, for the same reason as the text and the face: the vault they came
   * from is private and the reader has no account at all. Re-sharing replaces the whole set, so a
   * picture removed from the note stops being served.
   */
  assets?: { name: string; bytes: Buffer }[]
}

export class ShareLimitError extends Error {
  constructor(message: string, readonly kind: 'too-large' | 'too-many') {
    super(message)
    this.name = 'ShareLimitError'
  }
}

export class ShareStore {
  /** Metadata only. The notes stay on disk until someone asks for one. */
  private index = new Map<string, ShareMeta>()

  private constructor(private readonly root: string) {}

  /** Reads every record's metadata once. A cold start with a thousand shares reads a few hundred KB. */
  static async open(root: string): Promise<ShareStore> {
    const store = new ShareStore(path.resolve(root))
    await fs.mkdir(store.root, { recursive: true })

    for (const name of await fs.readdir(store.root)) {
      if (!name.endsWith('.json')) continue
      try {
        const meta = JSON.parse(await fs.readFile(path.join(store.root, name), 'utf8')) as ShareMeta
        if (typeof meta.id === 'string' && meta.id === name.slice(0, -5)) store.index.set(meta.id, meta)
      } catch {
        // A record that cannot be parsed is one broken link, not a reason to refuse to start.
      }
    }
    return store
  }

  /** For the sweep's log line, and for tests. */
  size(): number {
    return this.index.size
  }

  /**
   * Share a note, or re-share the one already shared from this path.
   *
   * Extending is the same call: the design has no separate control for it, because "press Share
   * again" is a thing people already know how to do. The link does not change, so one that has
   * been sent stays good; the text is replaced, because a share is a copy and re-sharing is how
   * you update the copy.
   */
  async create(input: ShareInput, now: number): Promise<ShareMeta> {
    const bytes = Buffer.byteLength(input.content, 'utf8')
    if (bytes > MAX_CONTENT_BYTES) {
      // Rounded up, never down: one byte over the cap must not report the cap back as the size,
      // which reads as a refusal for no reason.
      throw new ShareLimitError(`this note is ${Math.ceil(bytes / 1024)}KB`, 'too-large')
    }

    const existing = this.find(input.ownerId, input.repo, input.path)
    if (existing === null && this.listFor(input.ownerId, now).length >= MAX_PER_ACCOUNT) {
      throw new ShareLimitError(`${MAX_PER_ACCOUNT} notes are already shared`, 'too-many')
    }

    const id = existing?.id ?? await this.freshId()
    const meta: ShareMeta = {
      id,
      ownerId: input.ownerId,
      ownerLogin: input.ownerLogin,
      repo: input.repo,
      path: input.path,
      title: input.title,
      createdAt: existing?.createdAt ?? now,
      expiresAt: now + LIFETIME_MS,
      purgeAt: now + LIFETIME_MS + TOMBSTONE_MS,
      stopped: false,
    }

    // Text first: a record whose note is missing is a broken link, where a note with no record is
    // merely a file the sweep will collect.
    await fs.writeFile(this.notePath(id), input.content, 'utf8')
    // Then the faces, replaced or removed together with it — re-sharing an edited note must never
    // leave the previous note's glyphs behind.
    for (const weight of FONT_WEIGHTS) {
      const cut = input.fonts?.[weight]
      if (cut === undefined) await rm(this.fontPath(id, weight))
      else await fs.writeFile(this.fontPath(id, weight), cut)
    }
    // And the pictures, replaced as a set for the same reason as the faces.
    await this.dropAssets(id)
    for (const asset of input.assets ?? []) {
      if (!SAFE_ASSET.test(asset.name)) continue
      await fs.writeFile(this.assetPath(id, asset.name), asset.bytes)
    }
    await this.writeMeta(meta)
    return meta
  }

  async read(id: string, now: number): Promise<ShareRead> {
    const meta = this.index.get(id)
    if (meta === undefined) return { ok: false, reason: 'missing' }
    if (meta.stopped) return { ok: false, reason: 'stopped' }
    if (now >= meta.expiresAt) {
      // Read past its death: the note goes now rather than waiting for the daily pass.
      await this.dropNote(id)
      return { ok: false, reason: 'expired' }
    }

    try {
      return { ok: true, meta, content: await fs.readFile(this.notePath(id), 'utf8') }
    } catch {
      // The record says there is a note and there is not. Nothing can be served, and saying
      // "expired" would be a guess — this is the one case that is genuinely nothing.
      return { ok: false, reason: 'missing' }
    }
  }

  /** Only the account that made it. Returns false when it is not theirs or was never there. */
  async stop(id: string, ownerId: number, now: number): Promise<boolean> {
    const meta = this.index.get(id)
    if (meta === undefined || meta.ownerId !== ownerId || meta.stopped) return false
    await this.dropNote(id)
    await this.writeMeta({ ...meta, stopped: true, purgeAt: now + TOMBSTONE_MS })
    return true
  }

  /** What this account has shared and could still stop. Never more than {@link MAX_PER_ACCOUNT}. */
  listFor(ownerId: number, now: number): ShareMeta[] {
    const mine: ShareMeta[] = []
    for (const meta of this.index.values()) {
      if (meta.ownerId === ownerId && !meta.stopped && now < meta.expiresAt) mine.push(meta)
    }
    return mine.sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * The daily pass, for everything nobody came back to read.
   *
   * Expiry alone would leave the text of every unread share on disk forever, which is the one way
   * a store with a lifetime still grows without bound.
   */
  async sweep(now: number): Promise<{ emptied: number; removed: number }> {
    let emptied = 0
    let removed = 0
    for (const meta of [...this.index.values()]) {
      if (now >= meta.purgeAt) {
        this.index.delete(meta.id)
        await this.dropNote(meta.id)
        await rm(this.metaPath(meta.id))
        removed += 1
      } else if (now >= meta.expiresAt && await this.dropNote(meta.id)) {
        emptied += 1
      }
    }
    return { emptied, removed }
  }

  private find(ownerId: number, repo: string, notePath: string): ShareMeta | null {
    for (const meta of this.index.values()) {
      if (meta.ownerId === ownerId && meta.repo === repo && meta.path === notePath && !meta.stopped) {
        return meta
      }
    }
    return null
  }

  private async writeMeta(meta: ShareMeta): Promise<void> {
    await fs.writeFile(this.metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf8')
    this.index.set(meta.id, meta)
  }

  /**
   * Give an existing share the face it was made without.
   *
   * Only for shares that predate per-note faces: `create` writes them with the note, which is what
   * keeps the two from drifting. This writes nothing else, so it cannot.
   */
  async attachFonts(id: string, fonts: Record<FontWeight, Buffer>): Promise<void> {
    if (!this.index.has(id)) return
    for (const weight of FONT_WEIGHTS) await fs.writeFile(this.fontPath(id, weight), fonts[weight])
  }

  /** Whether this note has a face of its own, without reading it. */
  async hasFont(id: string): Promise<boolean> {
    return exists(this.fontPath(id, 'regular'))
  }

  /** A picture this note carries, or null. The name is checked here as well as at the route. */
  async asset(id: string, name: string): Promise<Buffer | null> {
    if (!SAFE_ASSET.test(name)) return null
    try {
      return await fs.readFile(this.assetPath(id, name))
    } catch {
      return null
    }
  }

  /** The face this note's text was cut to, or null when it has none. */
  async font(id: string, weight: FontWeight): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.fontPath(id, weight))
    } catch {
      return null
    }
  }

  /** True when there was a note to drop, which is what makes the sweep's count honest. */
  private async dropNote(id: string): Promise<boolean> {
    // The faces are part of the note: nothing else can use them, and they are the larger half.
    for (const weight of FONT_WEIGHTS) await rm(this.fontPath(id, weight))
    await this.dropAssets(id)
    return rm(this.notePath(id))
  }

  /**
   * Every picture this share is carrying.
   *
   * Read from the directory rather than from the record, because the names are the notes' and not
   * ours — a share whose picture set changed must not leave the previous set behind, and the
   * record has never held a list to compare against.
   */
  private async dropAssets(id: string): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(this.root)
    } catch {
      return
    }
    const prefix = `${id}-asset-`
    for (const name of names) {
      if (name.startsWith(prefix)) await rm(path.join(this.root, name))
    }
  }

  private async freshId(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let id = ''
      for (let i = 0; i < ID_LENGTH; i += 1) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
      // The index is the authority in memory; the file check catches a record this process has
      // never read, which is what a directory shared with an older process would look like.
      if (!this.index.has(id) && !await exists(this.metaPath(id))) return id
    }
    throw new Error('could not allocate a share id')
  }

  private metaPath(id: string): string {
    return path.join(this.root, `${id}.json`)
  }

  private notePath(id: string): string {
    return path.join(this.root, `${id}.md`)
  }

  private assetPath(id: string, name: string): string {
    return path.join(this.root, `${id}-asset-${name}`)
  }

  private fontPath(id: string, weight: FontWeight): string {
    return path.join(this.root, `${id}-${weight}.woff2`)
  }
}

async function rm(file: string): Promise<boolean> {
  try {
    await fs.unlink(file)
    return true
  } catch {
    return false
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
