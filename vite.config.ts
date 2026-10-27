import { readFileSync } from 'node:fs'
import preact from '@preact/preset-vite'
import { defineConfig, type Plugin } from 'vite'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

/**
 * The commit this bundle was built from, for the Version row in Settings.
 *
 * It comes in as an environment variable rather than from git, because `.git` is in
 * `.dockerignore` and the build container cannot ask. the deploy script runs on the host inside
 * the repository — it already prints the commit — and passes what it knows.
 *
 * A local build has none and says `dev`. Better an honest word than a plausible sha that is not
 * the one running.
 */
const commit = process.env.GIT_SHA?.trim() || 'dev'

/** Where the skill lives in this repository, and where it is served from. */
const SKILL_SOURCE = 'skills/inkstone-live-doc/SKILL.md'
const SKILL_PATH = '/SKILLS.md'

/**
 * The agent's instructions, served from the application's own origin.
 *
 * An agent is handed a session link and a token and nothing else — see
 * `docs/design/live-agent.md` — so the one thing it can always reach is the host those came from.
 * Putting the skill there means `curl https://<host>/SKILLS.md` is the whole of "how do I use
 * this", with no repository to find and no account to have.
 *
 * Emitted from the file rather than copied into `public/`: two copies of a document in one
 * repository is two documents, and the one that drifts is always the one nobody is reading.
 */
function serveSkill(): Plugin {
  const read = () => readFileSync(SKILL_SOURCE, 'utf8')
  return {
    name: 'inkstone-serve-skill',
    // The built site, which is what the server hands out.
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: SKILL_PATH.slice(1), source: read() })
    },
    // And the dev server, so it is not a path that exists only in production.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== SKILL_PATH) return next()
        res.setHeader('content-type', 'text/markdown; charset=utf-8')
        res.end(read())
      })
    },
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
  },
  plugins: [preact(), serveSkill()],
  root: '.',
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // `changeOrigin: false` keeps the browser's own Host header. The GitHub sign-in derives its
      // redirect_uri from it, and a rewritten Host makes that `127.0.0.1:7654` — an origin GitHub
      // has never heard of.
      '/api': { target: 'http://127.0.0.1:7654', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:7654', ws: true, changeOrigin: false },
    },
  },
})
