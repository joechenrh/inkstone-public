import { BackendError } from '../backend.js'

const API = 'https://api.github.com'

/** GitHub's own media types, used where they save the app a decoding step. */
export const RAW = 'application/vnd.github.raw'
export const DIFF = 'application/vnd.github.diff'
const JSON_MEDIA = 'application/vnd.github+json'

export interface RestOptions {
  /**
   * Called before every request. A function rather than a string because an installation token
   * lives an hour, so by slice 4 this refreshes; a plain string would go stale mid-session.
   */
  token: () => Promise<string> | string
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch
}

/**
 * The bit of GitHub's REST API this app speaks, and the one place its failures become
 * {@link BackendError}s.
 *
 * Measured before this was written (see `docs/design/public-route.md`): every read here answers a
 * browser on another origin with a readable body, and a POST carrying `content-type` and
 * `Authorization` gets its preflight through. The tarball endpoint does not, which is why there is
 * no bulk-download path in here.
 */
export class GitHubRest {
  readonly #token: RestOptions['token']
  readonly #fetch: typeof globalThis.fetch

  constructor(options: RestOptions) {
    this.#token = options.token
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** JSON in, JSON out. `accept` overrides the media type — {@link RAW} and {@link DIFF} return text. */
  async request<T>(
    path: string,
    init: { method?: string; body?: unknown; accept?: string } = {},
  ): Promise<T> {
    const accept = init.accept ?? JSON_MEDIA
    const headers: Record<string, string> = {
      accept,
      authorization: `Bearer ${await this.#token()}`,
      'x-github-api-version': '2022-11-28',
    }
    if (init.body !== undefined) headers['content-type'] = 'application/json'

    let res: Response
    try {
      res = await this.#fetch(`${API}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    } catch (cause) {
      // A network-level failure, or a CORS refusal — which the browser reports as the same
      // opaque TypeError, giving the app nothing more specific to say than this.
      throw new BackendError('Could not reach GitHub', 0)
    }

    const text = await res.text()
    if (!res.ok) throw restError(res, text)
    if (accept !== JSON_MEDIA) return text as T
    return (text === '' ? undefined : JSON.parse(text)) as T
  }
}

function restError(res: Response, text: string): BackendError {
  // Rate limiting arrives as a 403 (or 429) with the remaining budget at zero, and is worth
  // separating: it is the one failure that fixes itself, at a time the response states.
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    const at = Number.isFinite(reset) && reset > 0
      ? new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null
    return new BackendError(
      at ? `GitHub rate limit reached — it resets at ${at}` : 'GitHub rate limit reached',
      res.status,
    )
  }

  let message = `GitHub returned ${res.status}`
  try {
    const body = JSON.parse(text) as { message?: string }
    if (typeof body.message === 'string' && body.message !== '') message = body.message
  } catch { /* a non-JSON error body: the status is all there is to say */ }
  return new BackendError(message, res.status)
}
