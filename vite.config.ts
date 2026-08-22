import { readFileSync } from 'node:fs'
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

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

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
  },
  plugins: [preact()],
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
