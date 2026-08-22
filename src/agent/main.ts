import { codexBackend } from './backends/codex.js'
import { startAgent } from './server.js'

/**
 * `inkstone-agent` — run it on your own machine, paste what it prints, close the terminal to stop.
 *
 * Deliberately a foreground process, the same shape as the backend it drives. A daemon flag can
 * come later; it should not come first, because a background process holding an agent open is a
 * thing people should choose rather than acquire.
 *
 * The terminal may name the backend, because the person reading it installed that backend. The
 * *interface* never does — see `backend.ts`.
 */

const ORIGIN = process.env.INKSTONE_ORIGIN ?? 'https://notes.example.com'

const agent = await startAgent({
  origin: ORIGIN,
  backends: [codexBackend({ detect: { bin: process.env.CODEX_BIN }, run: { bin: process.env.CODEX_BIN } })],
})

const lines = [
  '',
  // Naming them here is correct: the person reading this installed them, and is looking at their
  // own PATH. The interface upstairs never does.
  ...agent.backends.map((b) => (b.found
    ? `${b.id} ${b.version ?? '(version unknown)'} found at ${b.path}`
    : `${b.id} was not found on your PATH`)),
  ...(agent.backends.some((b) => b.found) ? [] : ['nothing to run — install one of the above, then run this again']),
  `this machine is ${agent.machine}`,
  `listening on http://${'127.0.0.1'}:${agent.port}  (this machine only)`,
  `talking to ${ORIGIN}`,
  '',
  'Paste this into Inkstone → Settings → Agent:',
  '',
  `    ${agent.pairing}`,
  '',
  'Anyone who has that line can drive the agent on this machine. Ctrl-C to stop.',
  '',
]
console.log(lines.join('\n'))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void agent.close().then(() => process.exit(0))
  })
}
