import { readFileSync } from 'node:fs'
import { defineWorkspace } from 'vitest/config'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

/**
 * The same two constants the bundle is built with.
 *
 * A workspace project does not inherit `define` from the root config, so without this the web
 * project sees no `__APP_VERSION__` and every file that reaches `version.ts` fails to collect —
 * which reports as *zero tests in that file* rather than as a failure, and is therefore invisible
 * in a summary line. Five tests went missing that way before this was here.
 */
const buildConstants = {
  __APP_VERSION__: JSON.stringify(version),
  __APP_COMMIT__: JSON.stringify('test'),
}

export default defineWorkspace([
  {
    test: {
      name: 'server',
      environment: 'node',
      globals: true,
      include: ['tests/server/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'agent',
      environment: 'node',
      globals: true,
      include: ['tests/agent/**/*.test.ts'],
    },
  },
  {
    define: buildConstants,
    test: {
      name: 'web',
      environment: 'jsdom',
      globals: true,
      setupFiles: ['tests/web/setup.ts'],
      include: ['tests/web/**/*.test.ts', 'tests/web/**/*.test.tsx'],
    },
  },
])
