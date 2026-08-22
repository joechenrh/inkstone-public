import type { RunEvent, RunRequest, RunResult } from './backends/codex-run.js'

/**
 * The one thing the agent runs, behind a name that is not its name.
 *
 * Codex is the only implementation and will be for a while. The seam exists anyway, for two
 * reasons that are worth separating:
 *
 * - **Another one is expected.** Not hypothetically — it is why this interface is here rather than
 *   a `codex.ts` imported directly by the server.
 * - **The wire format outlives the code.** `/status` says `backend`, not `codex`, because a browser
 *   that learned the word `codex` would have to unlearn it in public, across versions of an app
 *   that updates itself and a binary that does not.
 *
 * This is deliberately not a registry, a plugin loader, or a capability negotiation. It is a type
 * and a list that currently holds one. When there are two, the differences between them will say
 * what the abstraction actually needs to be — guessing now would be guessing.
 *
 * A `capabilities` field was drafted and cut, which is worth recording because it is the same
 * mistake one size down: it described a difference that does not exist. Web search was the example,
 * and there is no agent worth wiring up that cannot search the web. The plural is in the *shape* —
 * a list, and a browser that names which entry it wants — not in machinery for differences nobody
 * has seen yet.
 *
 * `RunRequest`, `RunResult` and `RunEvent` still live under `backends/` and are imported back up
 * here, which is the wrong direction and is left deliberately: moving them is churn until there is
 * a second backend to say whether they are general or merely codex's.
 */

export interface BackendPresence {
  found: boolean
  /** As the backend reports it, trimmed. Null when it could not be asked. */
  version: string | null
  /** Where it was found, for a person diagnosing a PATH that differs from their shell's. */
  path: string | null
}

export interface Backend {
  /**
   * Stable, lowercase, and shown to nobody — the interface says "agent". Unique within the list a
   * binary is started with, because this is what a browser names on every run.
   */
  id: string
  /** What it is called when a version has to be attributed to something. */
  label: string
  detect(): Promise<BackendPresence>
  run(
    request: RunRequest,
    onEvent: (event: RunEvent) => void,
  ): Promise<RunResult>
}
