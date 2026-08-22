import fastifyStatic from '@fastify/static'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AutoCommit } from './autocommit.js'
import { registerAuth } from './auth.js'
import { registerGitHubAuth } from './github-auth.js'
import type { Config } from './config.js'
import { broadcastGitStatus } from './git-broadcast.js'
import { VaultGitError, type VaultGit } from './git/index.js'
import { registerFileRoutes } from './routes/files.js'
import { registerShareRoutes } from './share/routes.js'
import type { ShareStore } from './share/store.js'
import { VaultError, type Vault } from './vault/index.js'
import { VaultPathError } from './vault/paths.js'
import { VaultWatcher } from './watcher.js'
import { WsHub } from './ws.js'

export interface AppDeps {
  config: Config
  /**
   * The vault half, absent in github mode.
   *
   * Without it there is no directory to watch, no repository to commit, and no `/api/file*`
   * routes at all — the browser talks to GitHub itself. See `docs/design/public-route.md`.
   */
  vault?: Vault
  git?: VaultGit
  autoCommit?: AutoCommit
  /**
   * Where shared notes are kept. Absent unless the deployment named a directory, in which case the
   * share routes are not registered at all and the app is told there is no sharing here.
   */
  shareStore?: ShareStore
  /** Override the web root directory (used in tests to avoid depending on build artefacts). */
  webRoot?: string
  /**
   * Pino log level for Fastify's built-in logger. When absent (the default
   * used by tests), the logger is disabled so test runs produce no output.
   * The production entrypoint (main.ts) passes the LOG_LEVEL env var here so
   * that req.log.error(...) in setErrorHandler actually emits to stdout.
   */
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
}

export interface App {
  instance: FastifyInstance
  hub: WsHub
  /** Null in github mode: nothing on this disk to watch. */
  watcher: VaultWatcher | null
  autoCommit: AutoCommit | null
}

export function buildApp(deps: AppDeps): App {
  // When deps.logLevel is absent (e.g. in tests), the logger is disabled so
  // test runs produce no output. When present (e.g. from main.ts passing the
  // LOG_LEVEL env var), Fastify's built-in pino logger is active and
  // req.log.error(...) in setErrorHandler actually emits — the "operator sees
  // the real error" half of the scrubbing guarantee is live.
  const logger = deps.logLevel ? { level: deps.logLevel } : false
  const app = Fastify({ logger })
  const hub = new WsHub()
  const vaultRoot = deps.config.vault?.root ?? null
  const watcher = vaultRoot === null
    ? null
    : new VaultWatcher({ root: vaultRoot, onEvent: (event) => hub.broadcast(event) })

  app.register(cookie, { secret: deps.config.sessionSecret })
  app.register(websocket)

  // Must be registered on the top-level app instance, not inside a nested
  // app.register(async (instance) => ...) closure: Fastify's hooks and
  // decorators are scoped to their encapsulation context, so an onRequest hook
  // and decorator registered inside a child context only protect/expose routes
  // registered within that same closure. If routes are later split into
  // separate plugins (the common Fastify pattern), auth registered in a child
  // context would silently fail to cover those routes.
  // Registering at the top level ensures the guard naturally covers routes
  // regardless of how they are registered, without relying on future authors
  // following a convention.
  //
  // Note: the example code in the brief's Step 7 placed registerAuth,
  // registerFileRoutes, and hub.registerRoute all inside the same
  // `app.register(async (instance) => {...})` closure — exactly the pitfall
  // this comment and the three regression tests in
  // tests/server/auth.test.ts ("auth guard covers the top-level instance"
  // describe block) are guarding against: hooks/decorators in a child context
  // are not applied to sibling routes registered outside that closure, or to
  // routes registered directly on the top-level instance. Copying the example
  // verbatim would turn all three regression tests red (sibling plugin route
  // returns 200, direct top-level route returns 200, `app.isAuthenticated`
  // undefined at the top level). registerAuth/registerFileRoutes here do not
  // copy the example; they continue using the flat top-level registration
  // pattern validated in previous tasks.
  // Wire autocommit → broadcast: each successful autosave commit pushes a
  // git-status snapshot to all connected browsers so the git indicator updates
  // live without any polling. setOnCommit must be called after hub is created
  // (hub is local to buildApp) and before autoCommit.start() (called by main.ts
  // after buildApp returns), so here is the correct place.
  const git = deps.git
  if (deps.autoCommit && git) {
    deps.autoCommit.setOnCommit(() => {
      void broadcastGitStatus(git, hub)
    })
  }

  registerAuth(app, deps.config)
  registerGitHubAuth(app, deps.config.github)
  registerShareRoutes(app, { store: deps.shareStore ?? null })
  // In github mode these are simply not registered: a route that would read a vault this server
  // does not have is better absent than present and failing.
  if (deps.vault && git && deps.autoCommit && watcher) {
    registerFileRoutes(app, { ...deps, vault: deps.vault, git, autoCommit: deps.autoCommit, watcher, hub })
  }

  // Static asset hosting and SPA fallback.
  //
  // Path derivation: when `dist/server/main.js` calls buildApp, import.meta.url
  // is `file:///…/dist/server/app.js`. new URL('../web', import.meta.url) resolves
  // to `dist/web/` — exactly where `vite build` writes its output
  // (build.outDir: "dist/web" in vite.config.ts). The path traversal is:
  //   dist/server/app.js → ../web → dist/web/
  //
  // During development or tests the dist/ tree may not exist yet. If the
  // resolved directory is absent we skip registration entirely — the API routes
  // continue to work fine; only static assets are unavailable.
  //
  // Callers may pass deps.webRoot to override the resolved path (tests do this
  // with a scratch directory so they never require a production build).
  const webRoot =
    deps.webRoot ?? path.resolve(fileURLToPath(new URL('../web', import.meta.url)))

  if (fs.existsSync(webRoot)) {
    app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      // index.html: served by the SPA fallback below, not as a directory index,
      // so we disable Fastify-static's own index handling to avoid a race where
      // two code paths each try to set the 404 handler.
      index: false,
      // Disable @fastify/send's built-in Cache-Control generation so that the
      // setHeaders hook below is the sole author of that header. Without this,
      // @fastify/send builds its own "public, max-age=0" and places it in the
      // `headers` object that @fastify/static passes to reply.headers() AFTER
      // setHeaders fires — overwriting whatever the hook wrote to reply.raw.
      cacheControl: false,
      // Cache hashed assets aggressively; index.html must never be cached so a
      // returning user always gets the latest bundle pointers after a deploy.
      // We differentiate by using Fastify-static's setHeaders hook.
      // This hook fires on both direct file requests AND reply.sendFile() calls
      // (both go through the same pumpSendToReply code path in @fastify/static).
      setHeaders(res, filePath) {
        if (path.basename(filePath) === 'index.html') {
          // Must re-validate every time — a stale cached index.html pointing at
          // deleted hashed asset filenames is the classic SPA deploy break.
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
        } else if (path.dirname(filePath).endsWith(`${path.sep}assets`)) {
          // Vite content-addresses everything it emits, so the name changes whenever the bytes do
          // and `immutable` is a fact rather than a hope. The fonts are imported from `src` for
          // exactly this reason, and land here too.
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else {
          // Everything else — chiefly Vditor's runtime assets, whose paths it hardcodes and which
          // therefore keep one name for ever. Marking those `immutable` was a year-long promise
          // this app cannot keep: replacing one leaves every cache between here and the reader
          // serving the old bytes with no way to reach them. A day, then revalidate; a 304 costs a
          // round trip and nothing else.
          res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate')
        }
      },
    })

    app.setNotFoundHandler((req, reply) => {
      // API routes and the WebSocket upgrade path must still 404 as JSON —
      // serving index.html for /api/* would silently mask missing endpoints.
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not found' })
      }
      // All other unknown paths fall back to index.html so that a hard reload
      // on a client-side route (e.g. /notes/foo) does not return a 404.
      return reply.sendFile('index.html', webRoot)
    })
  }

  // hub.registerRoute's route lives on the top-level instance (under
  // `hub.registerRoute(app)`), but the registration call must be placed inside
  // an app.after() callback to take effect. This is a purely sequencing
  // constraint, not a plugin defect:
  //
  // buildApp is a synchronous function. The `app.register(websocket)` call
  // above looks synchronous but only enqueues the plugin in avvio's startup
  // queue; the actual execution (including the onRoute hook @fastify/websocket
  // installs for itself) is deferred until app.ready()/listen(). If
  // `hub.registerRoute(app)` were called synchronously right here, the `/ws`
  // route would be registered before the websocket plugin's onRoute hook
  // exists — so the route would be treated as a plain HTTP route, never wrapped
  // by the "hijack then forward to the ws handler" layer, and upgrade requests
  // would fall through. The app.after() callback is also enqueued by avvio,
  // but after `app.register(websocket)`, so when it runs the websocket plugin
  // has already executed and its onRoute hook is in place, and the `/ws` route
  // is then registered and wrapped correctly.
  //
  // Previously this used a nested `app.register(async (instance) => {
  // hub.registerRoute(instance) })`, which also works, but was explained
  // incorrectly — it's not a library defect where "a {websocket:true} route on
  // the root instance receives a Reply instead of a Request" (that diagnosis
  // was disproved by reproduction: as long as the route is registered after the
  // websocket plugin finishes loading, the root instance receives a normal
  // FastifyRequest just fine). Replacing the nested form with app.after() means
  // the `/ws` route, like registerAuth/registerFileRoutes, genuinely lives on
  // the top-level instance, and no separate explanation is needed for "why this
  // one route can be nested when the top-level rule says otherwise" — the
  // top-level rule applies uniformly to every route here.
  app.after(() => {
    hub.registerRoute(app)
  })

  // Global fallback error handler. Fastify's default error handler echoes a
  // thrown error's `.message` verbatim into the 500 response body; Node's fs
  // error strings (and any unexpected throw) frequently embed the server's
  // absolute filesystem path. The "error messages must not contain the server's
  // absolute path" invariant established in Tasks 2–4 previously depended
  // entirely on each module wrapping its own errors — this adds a structural
  // backstop to catch any that slip through.
  //
  // The three known error types (VaultPathError/VaultError/VaultGitError) carry
  // messages deliberately constructed to contain only the caller's own relative
  // path and are safe to return to the client. Most routes already translate
  // them into specific status codes via sendVaultError in their own try/catch
  // (see routes/files.ts); the branches here are just the backstop for any
  // route that omits a try/catch and would otherwise degrade into leaking raw
  // server details.
  app.setErrorHandler<FastifyError>((err, req, reply) => {
    if (err instanceof VaultPathError) return reply.code(400).send({ error: 'invalid path' })
    if (err instanceof VaultError) return reply.code(400).send({ error: err.message })
    if (err instanceof VaultGitError) return reply.code(500).send({ error: err.message })
    // Fastify's own 4xx errors (e.g. JSON parse failure, body size limit) keep
    // their status code but their details are not echoed back.
    const status = err.statusCode ?? 500
    if (status >= 400 && status < 500) return reply.code(status).send({ error: 'bad request' })
    // Everything else is scrubbed; the raw error goes to the logger only.
    req.log.error({ err }, 'unhandled route error')
    return reply.code(500).send({ error: 'internal error' })
  })

  app.addHook('onClose', async () => {
    await watcher?.stop()
    deps.autoCommit?.stop()
  })

  return { instance: app, hub, watcher, autoCommit: deps.autoCommit ?? null }
}
