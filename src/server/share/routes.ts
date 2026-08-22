import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { FONT_WEIGHTS, subsetFor, type FontWeight } from './font.js'
import { GitHubUnreachable, whoamiWith, type ShareViewer } from './viewer.js'
import {
  MAX_CONTENT_BYTES,
  MAX_PER_ACCOUNT,
  MAX_SHARE_ASSET_BYTES,
  ShareLimitError,
  type ShareMeta,
  type ShareStore,
} from './store.js'

/**
 * The four routes sharing needs, and the one thing that makes them safe to run.
 *
 * An endpoint that stores arbitrary text and serves it from your own domain is a free host for
 * phishing pages, so **every share carries the GitHub account that made it**. There is no session
 * of this server's own: the browser already holds a user-to-server access token, sends it here,
 * and this file asks GitHub whose it is. That single fact is what turns a pastebin into a feature —
 * abuse is attributable, capped per account, and revocable.
 *
 * Reading is the exception and deliberately so. A link that needs an account is not a link.
 */

/** A note is capped at 64KB; this is that with room for the JSON around it. */
/**
 * The request cap, which has to hold a note *and* its pictures.
 *
 * Base64 costs a third on top of the bytes, and this leaves room for twice the picture cap on top
 * of that — deliberately, so that a share carrying too much is refused by the check below, which
 * can say what it came to, rather than by Fastify, which can only say the body was too big.
 */
const BODY_LIMIT = MAX_CONTENT_BYTES + Math.ceil(2 * MAX_SHARE_ASSET_BYTES * 4 / 3)

/** What a picture is served as. The same closed list the vault route serves from. */
const ASSET_TYPES: Record<string, string> = {
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', avif: 'image/avif',
}

export interface ShareRoutesDeps {
  /** Null when this server was given no `SHARE_DIR`: the routes are then not registered at all. */
  store: ShareStore | null
  /** Injectable so tests exercise these routes without reaching api.github.com. */
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export function registerShareRoutes(app: FastifyInstance, deps: ShareRoutesDeps): void {
  const store = deps.store
  if (store === null) return

  const now = deps.now ?? (() => Date.now())
  const whoami = whoamiWith({ fetch: deps.fetch ?? globalThis.fetch, now })

  async function viewerOr401(req: FastifyRequest, reply: FastifyReply): Promise<ShareViewer | null> {
    try {
      const viewer = await whoami(req)
      if (viewer === null) {
        await reply.code(401).send({ error: 'Your session ended. Sign in and share again.' })
        return null
      }
      return viewer
    } catch {
      await reply.code(503).send({ error: 'This server could not reach GitHub.' })
      return null
    }
  }

  /** What the app is told about a share of its own. Never the text: it already has that. */
  const publicMeta = (meta: ShareMeta) => ({
    id: meta.id,
    repo: meta.repo,
    path: meta.path,
    expiresAt: meta.expiresAt,
  })

  /** Share a note, or extend and replace the one already shared from this path. */
  app.post<{ Body: {
    repo?: unknown; path?: unknown; title?: unknown; content?: unknown; assets?: unknown
  } }>(
    '/api/share',
    { bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const viewer = await viewerOr401(req, reply)
      if (viewer === null) return reply

      const { repo, path: notePath, title, content, assets: sent } = req.body ?? {}
      if (typeof repo !== 'string' || typeof notePath !== 'string'
        || typeof title !== 'string' || typeof content !== 'string'
        || repo === '' || notePath === '') {
        return reply.code(400).send({ error: 'a share needs a repository, a path, a title and text' })
      }

      let assets: { name: string; bytes: Buffer }[]
      try {
        assets = decodeAssets(sent)
      } catch (err) {
        return reply.code(413).send({
          error: err instanceof Error ? err.message : 'those pictures are too large',
          kind: 'too-large',
          maxBytes: MAX_SHARE_ASSET_BYTES,
        })
      }

      try {
        const meta = await store.create({
          ownerId: viewer.id,
          ownerLogin: viewer.login,
          repo,
          path: notePath,
          title: title.slice(0, 200),
          content,
          // Cut from the snapshot, and written with it. A note goes on changing after it is
          // shared; the copy does not, so the face can never drift from the text it is for —
          // re-sharing replaces both in the same call or neither.
          fonts: await subsetFor(content),
          // Copied with the note, for the same reason the face is: the vault they came from is
          // private, the reader has no account at all, and a share is a snapshot rather than a
          // window. Re-sharing replaces the set, so a picture taken out of the note stops being
          // served with it.
          assets,
        }, now())
        return reply.send(publicMeta(meta))
      } catch (err) {
        if (err instanceof ShareLimitError && err.kind === 'too-large') {
          return reply.code(413).send({
            error: err.message,
            kind: 'too-large',
            maxBytes: MAX_CONTENT_BYTES,
          })
        }
        if (err instanceof ShareLimitError) {
          return reply.code(409).send({ error: err.message, kind: 'too-many', limit: MAX_PER_ACCOUNT })
        }
        throw err
      }
    },
  )

  /**
   * Which of this account's notes are shared, and until when.
   *
   * Asked once when the app opens, so the menu can say `Shared · 28 days left` without a request
   * per row. It is not a share list in the interface's sense — nothing renders it — it is how a
   * second device knows what the first one shared.
   */
  app.get('/api/shares', async (req, reply) => {
    const viewer = await viewerOr401(req, reply)
    if (viewer === null) return reply
    return reply.send({ shares: store.listFor(viewer.id, now()).map(publicMeta) })
  })

  app.delete<{ Params: { id: string } }>('/api/share/:id', async (req, reply) => {
    const viewer = await viewerOr401(req, reply)
    if (viewer === null) return reply
    // Someone else's share, or one that was never there: the same answer either way, because
    // telling a stranger which of their guesses exists is the beginning of enumerating the store.
    if (!await store.stop(req.params.id, viewer.id, now())) {
      return reply.code(404).send({ error: 'not shared' })
    }
    return reply.code(204).send()
  })

  /**
   * The face this note's own characters were cut to.
   *
   * Public, like the note. Revalidated rather than immutable: the id outlives a re-share, so the
   * bytes behind this URL change whenever the note does — the mistake `app.ts` makes a point of
   * not making twice.
   */
  app.get<{ Params: { id: string; weight: string } }>(
    '/api/share/:id/font/:weight',
    async (req, reply) => {
      const weight = req.params.weight.replace(/\.woff2$/, '') as FontWeight
      if (!FONT_WEIGHTS.includes(weight)) return reply.code(404).send({ error: 'no such weight' })

      const found = await store.read(req.params.id, now())
      if (!found.ok) return reply.code(404).send({ reason: found.reason })

      const face = await store.font(req.params.id, weight)
      if (face === null) return reply.code(404).send({ error: 'this note needed no face' })

      return reply
        .header('content-type', 'font/woff2')
        .header('cache-control', 'public, max-age=3600, must-revalidate')
        .send(face)
    },
  )

  /**
   * A picture a shared note carries.
   *
   * `public`, where the vault's own route says `private`: this page is already public and these
   * bytes are already immutable, because the name is the hash of them. It is the one place in this
   * application where a shared cache is doing exactly what it is for — and, on a pay-by-traffic
   * line, the one place it matters most.
   */
  app.get<{ Params: { id: string; name: string } }>(
    '/api/share/:id/asset/:name',
    async (req, reply) => {
      const type = ASSET_TYPES[req.params.name.slice(req.params.name.lastIndexOf('.') + 1).toLowerCase()]
      if (type === undefined) return reply.code(404).send({ error: 'not a kind of picture this serves' })

      // Through the note, not around it: a stopped or expired share must stop serving its pictures
      // at the same moment it stops serving its text.
      const found = await store.read(req.params.id, now())
      if (!found.ok) return reply.code(404).send({ reason: found.reason })

      const bytes = await store.asset(req.params.id, req.params.name)
      if (bytes === null) return reply.code(404).send({ error: 'no such picture' })

      return reply
        .header('content-type', type)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('x-content-type-options', 'nosniff')
        .send(bytes)
    },
  )

  /**
   * The reader's route, and the only one here that needs nothing at all.
   *
   * The three failures are three different sentences on the reader's screen, so they are three
   * different reasons here rather than one 404.
   */
  app.get<{ Params: { id: string } }>('/api/share/:id', async (req, reply) => {
    const found = await store.read(req.params.id, now())
    if (!found.ok) return reply.code(404).send({ reason: found.reason })

    // A share made before notes carried their own face gets one on its first read, rather than
    // waiting to be re-shared. One reader pays a few hundred milliseconds; every reader after that
    // — and this one, for its fonts — gets 96KB instead of two megabytes.
    if (!await store.hasFont(req.params.id)) {
      const cut = await subsetFor(found.content)
      if (cut !== null) await store.attachFonts(req.params.id, cut)
    }

    return reply
      // A shared note is a copy, frozen when it was shared, and it is not private — but it is also
      // not something a proxy should hold on to after the sharer stops it.
      .header('cache-control', 'no-store')
      .send({
        title: found.meta.title,
        path: found.meta.path,
        content: found.content,
        sharedAt: found.meta.createdAt,
        expiresAt: found.meta.expiresAt,
        // So the page knows to prefer this note's own face over the megabyte the app ships.
        hasFont: await store.hasFont(req.params.id),
      })
  })
}

/**
 * The pictures out of a share request, or a refusal naming the size.
 *
 * The name is not taken on trust anywhere: it decides a filename, and it comes over the network.
 * A name that is not the hash-and-extension shape a picture actually has is dropped rather than
 * corrected — the note referring to it will simply show nothing, which is what a note referring to
 * a picture that was never stored should do.
 */
function decodeAssets(sent: unknown): { name: string; bytes: Buffer }[] {
  if (!Array.isArray(sent)) return []
  const assets: { name: string; bytes: Buffer }[] = []
  let total = 0
  for (const item of sent) {
    if (typeof item !== 'object' || item === null) continue
    const { name, bytes } = item as { name?: unknown; bytes?: unknown }
    if (typeof name !== 'string' || typeof bytes !== 'string') continue
    if (!/^[a-f0-9]{16}\.(?:webp|png|jpe?g|gif|avif)$/.test(name)) continue

    const buffer = Buffer.from(bytes, 'base64')
    if (buffer.byteLength === 0) continue
    total += buffer.byteLength
    if (total > MAX_SHARE_ASSET_BYTES) {
      // Rounded up, never down — one byte over must not report the cap back as the size.
      throw new Error(`those pictures come to ${Math.ceil(total / 1024)}KB`)
    }
    assets.push({ name, bytes: buffer })
  }
  return assets
}

export type { ShareViewer }
