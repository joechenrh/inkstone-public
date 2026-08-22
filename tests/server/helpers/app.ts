import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { simpleGit } from 'simple-git'
import { AutoCommit } from '../../../src/server/autocommit.js'
import { buildApp } from '../../../src/server/app.js'
import type { Config } from '../../../src/server/config.js'
import { VaultGit } from '../../../src/server/git/index.js'
import { Vault } from '../../../src/server/vault/index.js'
import type { VaultWatcher } from '../../../src/server/watcher.js'
import type { WsHub } from '../../../src/server/ws.js'

export interface TestApp {
  app: FastifyInstance
  hub: WsHub
  watcher: VaultWatcher
  autoCommit: AutoCommit
  root: string
  config: Config
  cleanup: () => Promise<void>
}

/**
 * Builds the app but does NOT call `app.ready()`. Fastify rejects new route
 * registrations once an instance is ready, so tests that need to register
 * extra routes on the returned instance (e.g. to prove the auth guard covers
 * routes added via a separate `app.register(...)` call, or directly on the
 * top-level instance) must use this instead of `makeTestApp` and call
 * `app.ready()` themselves after registering.
 */
export async function makeUnreadyTestApp(): Promise<TestApp> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-app-'))
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.writeFile(path.join(root, 'notes', 'a.md'), '# a\n')

  const raw = simpleGit(root)
  await raw.init(['--initial-branch=main'])
  await raw.addConfig('user.email', 'test@example.com')
  await raw.addConfig('user.name', 'Test')
  await raw.add('.')
  await raw.commit('initial')

  const config: Config = {
    vault: { root, password: 'correct-horse' },
    sessionSecret: 'a-different-secret',
    listenAddr: '127.0.0.1',
    port: 0,
    github: null,
    share: null,
  }

  const gitWrapper = new VaultGit(root)
  const autoCommit = new AutoCommit({ git: gitWrapper })
  const built = buildApp({ config, vault: new Vault(root), git: gitWrapper, autoCommit })
  const app = built.instance

  return {
    app,
    hub: built.hub,
    watcher: built.watcher!,
    autoCommit: built.autoCommit!,
    root,
    config,
    cleanup: async () => {
      await app.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

export async function makeTestApp(): Promise<TestApp> {
  const t = await makeUnreadyTestApp()
  await t.app.ready()
  return t
}

/** Logs in and returns the cookie header ready to pass to subsequent requests. */
export async function login(t: TestApp): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: t.config.vault!.password },
  })
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!raw) throw new Error('login did not set a cookie')
  return raw.split(';')[0]!
}
