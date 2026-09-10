import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { UploadConfig } from '../config.js'
import { qiniu, UploadFailed, type Uploader } from '../../uploader/index.js'

/**
 * Where a pasted picture goes, when it is not to go into the vault.
 *
 * This server does the two things the uploader package deliberately does not: it decides *who* may
 * upload, and it reads the credentials out of the environment. The package takes bytes and answers
 * with a URL — see `src/uploader`, which imports nothing from here and could be lifted out whole.
 *
 * Nothing is recovered here either. A failure is reported as one, and the browser writes the
 * picture into the vault instead — falling back is a decision about notes, and it is made where the
 * note is.
 */

/** Big enough for a screenshot after the browser has re-encoded it, and not a byte more. */
const CEILING = 8 * 1024 * 1024

interface Deps {
  config: UploadConfig
  /** Injectable so the tests never go near Qiniu or GitHub. */
  makeUploader?: (config: UploadConfig) => Uploader
  fetch?: typeof globalThis.fetch
}

/**
 * Whether this request may spend the account's storage.
 *
 * Two ways in, because there are two ways to be signed in. A vault deployment has a password and a
 * session cookie, and whoever holds it is the owner. The GitHub route has neither — so the token
 * the browser is already using to read the repository is checked against GitHub itself, and the
 * login it belongs to must be the one named in `GITHUB_OWNER`.
 *
 * Without that name the route would be an image host open to everyone with a GitHub account, on
 * this account's bill. That is why an unnamed owner refuses rather than allows.
 */
async function allowed(
  req: FastifyRequest,
  app: FastifyInstance,
  deps: Deps,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const authenticated = (app as unknown as { isAuthenticated?: (r: FastifyRequest) => boolean })
    .isAuthenticated
  if (authenticated?.(req) === true) return { ok: true }

  const owner = deps.config.owner
  if (owner === null) {
    return { ok: false, why: 'this server has no GITHUB_OWNER, so only the vault password gets in' }
  }

  const header = req.headers.authorization ?? ''
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]
  if (token === undefined) return { ok: false, why: 'no credentials' }

  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
  try {
    const res = await doFetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return { ok: false, why: 'GitHub did not recognise that token' }
    const user = await res.json() as { login?: string }
    if (user.login !== owner) return { ok: false, why: 'not this account' }
    return { ok: true }
  } catch {
    // Cannot ask GitHub who this is, so cannot say yes. The picture goes into the vault instead,
    // which is what the browser does with any refusal.
    return { ok: false, why: 'could not check who you are' }
  }
}

export function registerUploadRoutes(app: FastifyInstance, deps: Deps): void {
  const uploader = (deps.makeUploader ?? ((c: UploadConfig) => qiniu(c.qiniu)))(deps.config)

  app.post<{ Body: { bytes?: unknown; ext?: unknown; hash?: unknown } }>(
    '/api/upload',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const permission = await allowed(req, app, deps)
      if (!permission.ok) return reply.code(403).send({ error: permission.why })

      const { bytes, ext, hash } = (req.body ?? {}) as { bytes?: unknown; ext?: unknown; hash?: unknown }
      if (typeof bytes !== 'string' || bytes.length === 0) {
        return reply.code(400).send({ error: 'bytes must be a base64 string' })
      }
      if (typeof ext !== 'string' || !/^[a-z0-9]{1,5}$/.test(ext)) {
        return reply.code(400).send({ error: 'ext must be a short lowercase extension' })
      }
      if (typeof hash !== 'string' || !/^[a-f0-9]{8,64}$/.test(hash)) {
        return reply.code(400).send({ error: 'hash must name the content' })
      }

      const raw = Buffer.from(bytes, 'base64')
      if (raw.byteLength === 0) return reply.code(400).send({ error: 'bytes decoded to nothing' })
      if (raw.byteLength > CEILING) {
        return reply.code(413).send({ error: `${raw.byteLength} bytes is past this server's ceiling` })
      }

      try {
        const url = await uploader.put(new Uint8Array(raw), ext, hash)
        return reply.send({ url })
      } catch (err) {
        const why = err instanceof UploadFailed ? err.message : 'the upload failed'
        // 502: this server is fine, the place it was asked to put the picture is not. The browser
        // reads any failure the same way — write it into the vault and say so.
        req.log.warn({ err }, 'upload failed')
        return reply.code(502).send({ error: why })
      }
    },
  )
}
