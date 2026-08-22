/**
 * What build this is, defined by Vite at build time.
 *
 * Two strings and no link: the source repository is private, so a link to the commit would fail
 * for anyone who is not a collaborator and would name the repository to everyone else.
 *
 * The commit is the useful half. `0.4.0` names a fortnight of builds; `0.4.0 · 67e0ead` names one,
 * which is the difference between a bug report that can be answered and one that cannot.
 */
declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string

export const APP_VERSION = __APP_VERSION__
export const APP_COMMIT = __APP_COMMIT__

/** `0.4.0 · 67e0ead`, or just `0.4.0` where the commit is unknown. */
export const buildLabel = APP_COMMIT === 'dev'
  ? `${APP_VERSION} · dev`
  : `${APP_VERSION} · ${APP_COMMIT}`
