# Inkstone

A web Typora you host yourself.

It runs in one of two modes, and the difference decides everything else — including where it may be reachable from.

| | **vault** | **github** |
|---|---|---|
| Where the notes are | A directory on this machine | The user's own GitHub repository |
| Who may sign in | One person, one shared password | Anyone with a GitHub account, each seeing only their own repository |
| What this server holds | The notes, and a git repository of them | Nothing but the app's own client secret |
| Where it may be reachable from | **An intranet or Tailscale address only** | The public internet |

Set the variables for one, the other, or both; with both, GitHub sign-in is what the browser is offered.

## Requirements

- Node 22+, pnpm
- vault mode: the vault directory must already be a git repository (`git init`)

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | required | Cookie signing key |
| `VAULT_ROOT` | vault mode | Vault root directory; must be a git repository |
| `AUTH_PASSWORD` | vault mode | Login password; must differ from `SESSION_SECRET` |
| `GITHUB_CLIENT_ID` | github mode | From the GitHub App's settings page |
| `GITHUB_CLIENT_SECRET` | github mode | The App's client secret. Never the private key — that is for installation tokens, which this does not use |
| `SHARE_DIR` | optional | Where read-only share links keep their notes. Needs the GitHub pair beside it, because every share is attributed to the account that made it. Unset, sharing does not exist — no routes, no menu item. See `docs/design/sharing.md` |
| `GITHUB_APP_SLUG` | — | The name in `github.com/apps/<slug>`, so someone with no repository installed has somewhere to go |
| `LISTEN_ADDR` | `127.0.0.1` | Bind address. See below before changing it |
| `PORT` | `7654` | Listen port |
| `LOG_LEVEL` | `info` | Log level (fatal/error/warn/info/debug/trace/silent) |

## Development

```bash
pnpm install
pnpm dev:server    # backend, 7654
pnpm dev:web       # frontend, Vite proxies to the backend
pnpm test          # unit tests
pnpm test:e2e      # end to end
```

## Deployment

```bash
pnpm build
node dist/server/main.js
```

## Design docs

See `docs/design/` for the as-built architecture, editor, theming, layout, and persistence notes.

## Security

Until this app could sign people in with GitHub, it had exactly one rule, stated here and in `docs/design/architecture.md`: **never expose it to the public internet, and never bind `0.0.0.0`.** That rule was right, and it is worth saying why rather than deleting it. The server held the notes on its own disk, let anyone in who knew one shared password, had no isolation between users because it had no users, and was to gain a codex process with write access to the vault. Reaching it at all was most of the way to owning what was in it.

**In vault mode all of that is still true, and the rule still stands.** `LISTEN_ADDR` defaults to `127.0.0.1`; set it to a Tailscale or intranet address, never `0.0.0.0`.

**github mode is what replaced the rule rather than lifting it.** There is no vault on this machine, no shared password, and nothing of anyone's to reach: the browser talks to `api.github.com` itself, and this server exchanges a sign-in code for a token and forgets. The access token is returned to the browser and held in memory; the refresh token is an `httpOnly` cookie, so script on the origin can spend it but not read it. What is left worth protecting is the App's client secret, which belongs to the app rather than to any user.

So the same binary is safe on the public internet in one mode and not in the other. The difference is not a setting to be careful with — it is whether `VAULT_ROOT` is set at all. See `docs/design/public-route.md`.
