import { createHmac } from 'node:crypto'
import { UploadFailed, type Uploader } from './index.js'

/**
 * Qiniu Kodo, through its form upload.
 *
 * No SDK: an upload credential is three pieces joined by colons — the access key, the signature of
 * the policy, and the policy itself — and the upload is a multipart POST of three fields. The whole
 * driver is this file and `node:crypto`.
 *
 * https://developer.qiniu.com/kodo/1208/upload-token
 */
export interface QiniuConfig {
  accessKey: string
  secretKey: string
  bucket: string
  /** The domain bound to the bucket, which is what makes a stored object readable. */
  baseUrl: string
  /**
   * The upload domain of the region the bucket is in — `https://up-z2.qiniup.com` and so on.
   *
   * Left out, the region is asked for once and remembered. Qiniu publishes an endpoint for exactly
   * this, and guessing at a default would mean every upload from a bucket in the wrong region
   * failing for a reason nobody could see.
   */
  uploadHost?: string
  /** How long a credential is good for. Seconds; the default is an hour. */
  expiry?: number
  /** Injectable, so the tests never go near the network. */
  fetch?: typeof globalThis.fetch
  now?: () => number
}

const QUERY = 'https://api.qiniu.com/v4/query'

/** base64, in the alphabet a URL can carry. */
function urlsafe(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
}

/**
 * The credential: `AccessKey : urlsafe(HMAC-SHA1(policy)) : urlsafe(policy)`.
 *
 * `scope` carries the key as well as the bucket, which is what makes the upload an overwrite — the
 * same picture pasted twice lands on itself rather than making a second object.
 */
export function uploadToken(config: QiniuConfig, key: string, deadline: number): string {
  const policy = JSON.stringify({ scope: `${config.bucket}:${key}`, deadline })
  const encoded = urlsafe(Buffer.from(policy, 'utf8'))
  const signature = urlsafe(createHmac('sha1', config.secretKey).update(encoded).digest())
  return `${config.accessKey}:${signature}:${encoded}`
}

/** Where a bucket's uploads go, asked once. */
async function regionHost(config: QiniuConfig, doFetch: typeof globalThis.fetch): Promise<string> {
  const url = `${QUERY}?ak=${encodeURIComponent(config.accessKey)}&bucket=${encodeURIComponent(config.bucket)}`
  let res: Response
  try {
    res = await doFetch(url)
  } catch (cause) {
    throw new UploadFailed('could not reach Qiniu to ask where the bucket is', 'unreachable', { cause })
  }
  if (!res.ok) {
    throw new UploadFailed(`Qiniu would not say where the bucket is (${res.status})`, 'refused')
  }
  const body = await res.json() as { hosts?: { up?: { acc?: { main?: string[] } } }[] }
  const host = body.hosts?.[0]?.up?.acc?.main?.[0]
  if (typeof host !== 'string' || host === '') {
    throw new UploadFailed('Qiniu named no upload host for this bucket', 'unexpected')
  }
  return `https://${host}`
}

export function qiniu(config: QiniuConfig): Uploader {
  const doFetch = config.fetch ?? globalThis.fetch.bind(globalThis)
  const now = config.now ?? (() => Date.now())
  const base = config.baseUrl.replace(/\/+$/, '')
  let host: Promise<string> | null = null

  return {
    name: 'qiniu',

    async put(bytes: Uint8Array, ext: string, hash: string): Promise<string> {
      const key = `assets/${hash}.${ext}`
      const deadline = Math.floor(now() / 1000) + (config.expiry ?? 3600)

      if (config.uploadHost !== undefined) host ??= Promise.resolve(config.uploadHost.replace(/\/+$/, ''))
      // Asked once and kept — but a failed answer must not be kept, or one bad minute would poison
      // every upload for the life of the process.
      host ??= regionHost(config, doFetch).catch((err: unknown) => { host = null; throw err })

      const form = new FormData()
      form.set('token', uploadToken(config, key, deadline))
      form.set('key', key)
      form.set('file', new Blob([bytes as unknown as BlobPart]), key.slice(key.lastIndexOf('/') + 1))

      let res: Response
      try {
        res = await doFetch(await host, { method: 'POST', body: form })
      } catch (cause) {
        throw new UploadFailed('could not reach Qiniu', 'unreachable', { cause })
      }

      if (!res.ok) {
        // Qiniu says why in the body, and its wording is better than anything invented here.
        const said = await res.text().catch(() => '')
        const why = /"error"\s*:\s*"([^"]*)"/.exec(said)?.[1] ?? `HTTP ${res.status}`
        throw new UploadFailed(`Qiniu refused it: ${why}`, res.status >= 500 ? 'unreachable' : 'refused')
      }

      return `${base}/${key}`
    },
  }
}
