import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/server/config.js'

const base = {
  VAULT_ROOT: '/tmp/vault',
  AUTH_PASSWORD: 'pw',
  SESSION_SECRET: 'secret',
}

describe('loadConfig', () => {
  it('fills in default values', () => {
    const cfg = loadConfig(base)
    expect(cfg.listenAddr).toBe('127.0.0.1')
    expect(cfg.port).toBe(7654)
  })

  it('reports the specific variable name when a required field is missing', () => {
    expect(() => loadConfig({ ...base, VAULT_ROOT: undefined })).toThrow(ConfigError)
    expect(() => loadConfig({ ...base, VAULT_ROOT: undefined })).toThrow(/VAULT_ROOT/)
  })

  it('rejects SESSION_SECRET and AUTH_PASSWORD being the same', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'pw' })).toThrow(/must differ/i)
  })

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/)
  })

  it('normalises the vault root to an absolute path with no trailing slash', () => {
    expect(loadConfig({ ...base, VAULT_ROOT: '/tmp/vault/' }).vault!.root).toBe('/tmp/vault')
  })
})

describe('the two modes', () => {
  const github = { GITHUB_CLIENT_ID: 'Iv23', GITHUB_CLIENT_SECRET: 'shhh', SESSION_SECRET: 's' }

  it('runs on GitHub sign-in alone, with no vault on this machine', () => {
    const cfg = loadConfig(github)
    expect(cfg.vault).toBeNull()
    expect(cfg.github).toEqual({ clientId: 'Iv23', clientSecret: 'shhh', appSlug: null })
  })

  it('runs on a vault alone, which is the original deployment', () => {
    const cfg = loadConfig({ VAULT_ROOT: '/tmp/v', AUTH_PASSWORD: 'pw', SESSION_SECRET: 's' })
    expect(cfg.github).toBeNull()
    expect(cfg.vault).toEqual({ root: '/tmp/v', password: 'pw' })
  })

  it('runs on both, which is the development arrangement', () => {
    const cfg = loadConfig({ ...github, VAULT_ROOT: '/tmp/v', AUTH_PASSWORD: 'pw' })
    expect(cfg.vault).not.toBeNull()
    expect(cfg.github).not.toBeNull()
  })

  it('refuses to start with neither, rather than serving nothing', () => {
    expect(() => loadConfig({ SESSION_SECRET: 's' })).toThrow(/nothing to serve/)
  })

  it('refuses half a vault in either direction', () => {
    // A vault with no password is an open directory; a password with no vault guards nothing.
    expect(() => loadConfig({ ...github, VAULT_ROOT: '/tmp/v' })).toThrow(/must be set together/)
    expect(() => loadConfig({ ...github, AUTH_PASSWORD: 'pw' })).toThrow(/must be set together/)
  })

  it('refuses half a GitHub app, which would fail at the exchange', () => {
    const vault = { VAULT_ROOT: '/tmp/v', AUTH_PASSWORD: 'pw', SESSION_SECRET: 's' }
    expect(() => loadConfig({ ...vault, GITHUB_CLIENT_ID: 'Iv23' })).toThrow(/must be set together/)
    expect(() => loadConfig({ ...vault, GITHUB_CLIENT_SECRET: 'shhh' })).toThrow(/must be set together/)
  })
})
