import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  // All tests share one server and one vault directory, and the file-tree CRUD test
  // creates and deletes files in it. Run serially so a concurrent test cannot observe
  // the tree mid-mutation (symptom: "waiting for getByText('hello.md')" timing out).
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:7699' },
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: 'http://127.0.0.1:7699/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
