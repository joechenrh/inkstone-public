import type { Backend } from '../backend.js'
import { findCodex, type CodexDeps } from './codex-detect.js'
import { run, type RunDeps } from './codex-run.js'

/**
 * Codex, as a backend.
 *
 * Everything codex-shaped lives under this directory: how it is found, how it is run, and which of
 * its flags are load-bearing. Nothing above here should know the word — see `../backend.ts`.
 */
export function codexBackend(deps: { detect?: CodexDeps; run?: RunDeps } = {}): Backend {
  return {
    id: 'codex',
    label: 'codex',
    detect: () => findCodex(deps.detect),
    run: (request, onEvent) => run(request, deps.run, onEvent),
  }
}
