import { identityProvider } from '../auth/identity.js'
import { signal } from '@preact/signals'
import { safeGetItem, safeSetItem } from '../theme/storage.js'

/**
 * The picture host, from the browser's side.
 *
 * Two signals and one call. Where the bytes actually go is the server's business — it holds the
 * credentials and hands them to `src/uploader`, which is a package that knows nothing about notes.
 * This file knows only whether there is such a place, whether the reader wants to use it, and how
 * to ask.
 *
 * **It never throws for the caller to catch and forget.** A failure here means the picture goes
 * into the vault instead, which is the whole reason the switch is safe to leave on: the worst case
 * is where the picture would have gone anyway.
 */

const KEY = 'inkstone.uploadToCdn'

/** The driver this server was given, or null. From `/api/config`; nothing to switch without it. */
export const uploadDriver = signal<string | null>(null)

/** Whether to use it. On by default — a server that was given a picture host was given it to use. */
export const uploadToCdn = signal(safeGetItem(KEY) !== '0')

export function setUploadToCdn(on: boolean): void {
  uploadToCdn.value = on
  safeSetItem(KEY, on ? '1' : '0')
}

/** Whether a picture should be offered to the host at all, this time. */
export function cdnIsOn(): boolean {
  return uploadDriver.value !== null && uploadToCdn.value
}

export interface CdnResult {
  /** The address the picture can be read at, or null when it did not get there. */
  url: string | null
  /** What to say about it, when it did not. Empty when it did. */
  why: string
}

/**
 * Offer the bytes to the host.
 *
 * The GitHub route has no session cookie, so the token the browser is already using to read the
 * repository goes along — the server checks it against GitHub and against the login it was told to
 * expect. On the vault route there is no token and the cookie is enough; asking for one there would
 * mean signing in to GitHub to paste a picture into a local vault.
 */
export async function uploadToHost(bytes: Uint8Array, ext: string, hash: string): Promise<CdnResult> {
  let authorization: string | undefined
  try {
    const provider = identityProvider()
    authorization = `Bearer ${await provider.token()}`
  } catch {
    // No GitHub identity on this route. The cookie speaks for itself.
  }

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ bytes: toBase64(bytes), ext, hash }),
    })
    if (!res.ok) {
      const said = await res.json().catch(() => ({})) as { error?: string }
      return { url: null, why: said.error ?? `the picture host answered ${res.status}` }
    }
    const body = await res.json() as { url?: string }
    if (typeof body.url !== 'string' || body.url === '') {
      return { url: null, why: 'the picture host named no address' }
    }
    return { url: body.url, why: '' }
  } catch {
    return { url: null, why: 'could not reach this server' }
  }
}

/** The same encoding the vault route uses for a picture in a JSON body. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
