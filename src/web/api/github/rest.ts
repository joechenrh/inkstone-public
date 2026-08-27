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
  /**
   * Get one that is definitely new, throwing away whatever is held.
   *
   * A token can stop working before it expires: signing in on a second device replaces it, and
   * GitHub then answers every call from the first with `Bad credentials`. The token holder cannot
   * see that happen — its clock says the token is good for hours — so the only thing that knows is
   * a 401, and the only cure was reloading the page. Optional: without it a 401 is reported as it
   * always was.
   */
  renew?: () => Promise<string>
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
  readonly #renew: RestOptions['renew']
  readonly #fetch: typeof globalThis.fetch

  constructor(options: RestOptions) {
    this.#token = options.token
    this.#renew = options.renew
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** JSON in, JSON out. `accept` overrides the media type — {@link RAW} and {@link DIFF} return text. */
  async request<T>(
    path: string,
    init: { method?: string; body?: unknown; accept?: string } = {},
  ): Promise<T> {
    const accept = init.accept ?? JSON_MEDIA
    const send = async (token: string): Promise<Response> => {
      const headers: Record<string, string> = {
        accept,
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      }
      if (init.body !== undefined) headers['content-type'] = 'application/json'
      try {
        return await this.#fetch(`${API}${path}`, {
          method: init.method ?? 'GET',
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        })
      } catch {
        // A network-level failure, or a CORS refusal — which the browser reports as the same
        // opaque TypeError, giving the app nothing more specific to say than this.
        throw new BackendError('Could not reach GitHub', 0)
      }
    }

    let res = await send(await this.#token())
    /*
     * Once, with a token that is definitely new.
     *
     * A token can stop working before it expires — signing in on another device replaces it — and
     * nothing on this side can tell, because the expiry it was given has not passed. GitHub says
     * `Bad credentials`, which was shown to the reader as if it were their fault and cleared only
     * by reloading the page. One retry is the whole difference: if the fresh token is refused too,
     * the refusal is real and is reported.
     */
    if (res.status === 401 && this.#renew !== undefined) {
      res = await send(await this.#renew())
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
