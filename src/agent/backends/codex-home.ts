import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * A `CODEX_HOME` that carries the user's credentials and nothing else about them.
 *
 * This exists because of something a real run did. Asked to append a sentence to a note, codex ran
 * `sed -n '1,240p' /Users/…/.codex/skills/english-tutor/SKILL.md` and put **📝 English Feedback**
 * in the answer — a personal skill, loaded from the user's own codex home, changing what a request
 * driven by a web page does.
 *
 * The skill was the visible half. The rest of that directory is worse: `skills/` had fourteen more,
 * and beside it sit `rules/`, `AGENTS.md`, `hooks.json`, `plugins/`, `memories/` and `superpowers/`.
 * Every one of them is something the user configured for their own interactive use, and none of
 * them should be reachable by a prompt typed into a drawer.
 *
 * **Nothing in codex can turn this off.** Measured against 0.147.0: there is no `skills.enabled`,
 * `tools.skills`, `use_skills` or `features.skills` — `--strict-config` rejects all four against a
 * bogus control key that it also rejects. `skills` *is* a real field and `skills=[]` was tried; the
 * skill still loaded and the model still read it. `--ignore-user-config` skips `config.toml` and
 * says so in its own help text: *"auth still uses `CODEX_HOME`"*. So the only lever is the variable
 * itself.
 *
 * The credential is **symlinked, never copied**. This process must not read, write or hold a copy
 * of anyone's token; codex opens the link and gets the real file.
 */

/** Where the private home lives. Stable, so a token refresh is not orphaned every run. */
export function homeDir(): string {
  return path.join(os.homedir(), '.inkstone', 'codex-home')
}

function realHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
}

export interface HomeDeps {
  /** Both injectable so tests never touch a real credential. */
  from?: string
  to?: string
}

/**
 * Build it if it is not there, repair it if it is wrong, and return the path.
 *
 * Repair matters because of how a token refresh can land. If codex rewrites `auth.json` by
 * replacing rather than by writing through, the symlink becomes a regular file here and the real
 * one stops being updated — so this checks every time rather than only on the first run. The cost
 * of the link being restored over a newer token is one re-authentication; the cost of not checking
 * is a credential quietly diverging in two places.
 *
 * Returns null if the credential is not where it should be. The caller then runs without setting
 * the variable, because a codex that cannot authenticate is a worse failure than one that can read
 * a skill — and the reader would have no idea why.
 */
export async function privateHome(deps: HomeDeps = {}): Promise<string | null> {
  const from = deps.from ?? path.join(realHome(), 'auth.json')
  const to = deps.to ?? homeDir()
  const link = path.join(to, 'auth.json')

  if (!(await exists(from))) return null

  try {
    await fs.mkdir(to, { recursive: true, mode: 0o700 })
    const current = await fs.lstat(link).catch(() => null)
    if (current !== null && current.isSymbolicLink() && (await fs.readlink(link)) === from) return to
    if (current !== null) await fs.rm(link, { force: true })
    await fs.symlink(from, link)
    return to
  } catch {
    return null
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false)
}
