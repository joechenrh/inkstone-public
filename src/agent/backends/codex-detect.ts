import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Whether codex is on this machine, and which one.
 *
 * Checked at startup and reported through `/status`, so the drawer can say *"codex 0.31.0"* rather
 * than "connected" — a version is a fact, where "connected" is a claim. It also means the two
 * failures stay separate: **the binary not running** and **the binary running but unable to find
 * codex** are different problems with different fixes, and a drawer that conflates them sends
 * people to reinstall the wrong thing.
 *
 * Nothing here runs codex. It asks for a version and reads the answer.
 */

import type { BackendPresence } from '../backend.js'

export type CodexPresence = BackendPresence

export interface CodexDeps {
  /** Injectable so tests never depend on what happens to be installed. */
  exec?: (file: string, args: string[]) => Promise<{ stdout: string }>
  /** Overrides the binary looked for, so a user with a wrapper can point at it. */
  bin?: string
}

const VERSION_TIMEOUT_MS = 5_000

export async function findCodex(deps: CodexDeps = {}): Promise<CodexPresence> {
  const bin = deps.bin ?? 'codex'
  const exec = deps.exec ?? ((file, args) => run(file, args, { timeout: VERSION_TIMEOUT_MS }))

  let path: string | null = null
  try {
    // `which` rather than scanning PATH here: it resolves shell builtins, aliases the shell would
    // resolve, and the same answer the user gets when they type it.
    const { stdout } = await exec('which', [bin])
    path = stdout.trim() || null
  } catch {
    return { found: false, version: null, path: null }
  }
  if (path === null) return { found: false, version: null, path: null }

  try {
    const { stdout } = await exec(bin, ['--version'])
    // codex answers `codex-cli 0.31.0` or similar; the number is the useful half.
    const version = /\d+\.\d+\.\d+[^\s]*/.exec(stdout)?.[0] ?? stdout.trim()
    return { found: true, version: version || null, path }
  } catch {
    // On PATH but unwilling to say what it is. That is still "found" — the drawer should offer to
    // try rather than tell someone to install what they already have.
    return { found: true, version: null, path }
  }
}
