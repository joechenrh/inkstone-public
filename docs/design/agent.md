# The agent — replaced

This described an agent that ran as a binary on the user's own machine, paired to the browser with a
code, reached through a relay on this server, and shown in a side panel. It is gone.

Everything in it existed to give the browser a way to *reach* an AI: the pairing, the relay, the
backend seam, the NDJSON event stream. What replaced it needs none of that, because the AI is not in
this application at all — it is whatever program the owner points at an HTTP API onto a live
session. See [live-agent.md](live-agent.md), and [live-share.md](live-share.md) for the sessions it
works on.

What the measurements in the old record established is still true, and is why the relay existed at
all: a page served over `https` cannot reach `http://127.0.0.1` in WebKit, `ws://` is blocked in
every browser, and a phone can never reach another machine's loopback. Nothing in the new design
needs either — the only thing the browser talks to is its own origin.

The old record is in the history if it is ever wanted: `git log -- docs/design/agent.md`.
