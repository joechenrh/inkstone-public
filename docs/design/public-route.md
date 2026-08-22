# The public route — a design under consideration

> **Nothing here is built, and none of it describes the running system.** The rest of `docs/design/` is as-built; this file is not. Inkstone today is single-user: one `VAULT_ROOT`, one `AUTH_PASSWORD`, one git repo on the server's disk, and the invariant in [architecture.md](architecture.md) — never expose it to the public internet — is live and correct.
>
> This lives on the `public-route` branch, away from the version in daily use, and records a route worked through in conversation: if it is taken the reasoning is already written down, and if it is not, the reasons it was set aside are too.

## The shape

Every user brings **their own GitHub repository**. Inkstone edits it. The server serves the application and is not on the path between the notes and where they are stored.

```
their machine                  the meeting point              their browser
agent on a clone     ──────►   their GitHub repo   ◄──────    Inkstone

                     your server: serves the app, and is not on this path
```

That last line is the whole design. Everything below follows from it.

## Why the server stays off the path

| | Server-mediated | **Browser-direct** |
|---|---|---|
| Shape | The server clones each user's repo, edits, commits, pushes — today's Inkstone, per user | The server serves the app; the browser calls the GitHub API |
| Who can read the notes | You can: on disk, in logs, in backups, in a crash dump | Nobody but the user and GitHub |
| Trust rests on | Your promises and your operational discipline | The architecture — there is nothing to promise |
| Current server code | Mostly survives | The git and vault layers are rewritten as API calls in the browser |
| Cost | Disk, backups, quotas, abuse, and the liability of holding other people's writing | Close to nothing |

Browser-direct wins **not because it is more secure in the abstract**, but because it is the only one where safety is a fact about the design rather than a claim about intentions. A stranger's promise not to read your notes is worth very little; "the notes never reach his server" is checkable from the network tab.

It is also the honest reading of "users bring their own repo": the natural product is an editor that works on your repository, not a service that keeps a copy of it.

## Identity: GitHub, not Google

Google was the starting assumption because it is what people are used to. It is wrong here: if the notes live in a GitHub repo, Google means **one consent screen for identity and a second for the repo**. Signing in with GitHub establishes who they are and what may be touched at once.

How the repository access is asked for matters more than how identity is:

| Mechanism | What the user hands over | |
|---|---|---|
| Pasted personal access token | A long-lived credential they must scope themselves | **No.** It teaches people to paste credentials into strangers' sites, and you then hold something valuable indefinitely |
| OAuth App | The `repo` scope, which is *every* repository they have | **No.** There is no per-repo OAuth scope; the consent screen would have to say "all your repositories", and it would be right |
| **GitHub App** | An installation on **selected repositories**, `contents: read & write`, nothing else | **Yes.** They pick the repos on GitHub's own screen and revoke from their settings without asking you |

The GitHub App also settles custody, and in a simpler way than first written here. A GitHub App can act two ways: **server-to-server**, with installation tokens minted from the App's private key, or **user-to-server**, with a token that represents the person and is limited to the same installed repositories. This route wants the second — the browser is the thing making requests, and it is making them as the user.

That removes a secret rather than protecting one: **the server never needs the App's private key.** Its only secret is the App's own client secret, used once per sign-in to exchange a code for a token, and it is the App's rather than any user's. Tokens expire in eight hours and refresh. *"There is no token of yours on my server"* is a far stronger sentence than *"your token is encrypted at rest"*, and this is the shape in which it can actually be kept — subject to the one question below that is still open.

## What makes people feel safe

In descending order of worth. The first three are structural; the rest are presentation, and presentation without the structure is marketing.

- **Nothing to steal** — browser-direct, so there is no note on the server and no long-lived token.
- **They choose the repositories**, on GitHub's screen.
- **Revocation without you** — one click in GitHub settings. Say so, and link to it.
- **A short, boring permission list.** `contents: read & write` on selected repos. No email, no org membership, no workflow scope. Anything extra invites "why does a notes app need that", and the answer had better not be "convenience".
- ~~**Open source, with the deployed commit shown.**~~ **Not available here.** The reasoning stands — "here is the code" is weak alone, and "here is the code, and the running build is this commit" is checkable — but the source repository is private, so this deployment cannot offer it. Settings shows the commit anyway, as plain text and not a link: it makes a bug report answerable, and a link would 404 for everyone who is not a collaborator while naming the repository to everyone else. What carries the weight instead is the row below and the two above it, which are checkable from the network tab without reading a line of source.
- **A data statement in plain language on the sign-in screen**, not in a policy nobody opens.
- **Self-hosting as a first-class option** — the strongest signal a hosted service can give is that you do not need it.

The sign-in copy is a list of claims, each of which has to be true of the build. Write none of them before they are:

> You pick which repository, on GitHub's screen.
> Permission asked: read and write files in that repository. Nothing else.
> Your notes go from your browser to GitHub. They do not pass through this server.
> Revoke any time in your GitHub settings.
> Stored: which installation is yours. Not stored: your notes, your token, your email.

## Writing to GitHub without a commit explosion

**The naive version explodes.** GitHub's Contents API creates **one commit per call and carries one file per call**, so mapping Ctrl+S onto it turns writing a single note into dozens of commits, a history of noise, and a quick trip into the rate limit.

The fix is not a new idea — it is the model the app already has, with the storage renamed:

| Today | Browser-direct |
|---|---|
| Save to disk (Ctrl+S) | Write to the browser's local store |
| The working tree | **The browser's local store is the working tree** |
| Autocommit every 5 minutes | A timer commits the working store as **one** commit |
| Manual commit with a message | The commit panel, unchanged |

**Save is already not commit**, and has never been. Keeping that separation is what keeps the commit rate the same as it is now.

Three things have to be right:

1. **Use the Git Data API, not the Contents API.** blobs → tree → commit → update ref puts any number of files in one commit. The Contents API cannot, and that — not the save frequency — is the actual cause of the explosion.
2. **The local store must be durable**, not in memory: it is the working tree now, so closing a tab would otherwise discard uncommitted work. The app already has the habit — drafts are mirrored under `inkstone.draft:<path>` — just at a smaller scale. *(Built as `localStorage`, not the IndexedDB this originally said; the reasoning is under "What is built so far".)*
3. **The optimistic lock becomes a commit sha.** `baseMtimeMs` guards against a file changing under the editor; against a git tree the equivalent is the base sha, and a moved ref returns a conflict. **The conflict bar already exists for exactly this**, which is what an agent pushing to the same repo will cause.

Rate limits are not a concern at this shape: a user-to-server token allows 5,000 requests an hour per user, and the batching above makes writes a dozen or so.

### Measured, from a browser on another origin

The route rests on the browser being able to reach `api.github.com` at all, so that was checked before anything was built — unauthenticated, against a public repo, from a page served on `localhost`:

| | |
|---|---|
| `GET /repos/:o/:r` · `git/trees?recursive=1` · `git/blobs/:sha` · `commits?path=` | **200, `type: "cors"`, body readable** |
| `git/blobs/:sha` with `Accept: application/vnd.github.raw` | **200, and the response is the file's text** — no base64 hop, which is one less place for UTF-8 to go wrong |
| `POST git/blobs` with `content-type: application/json` and an `Authorization` header | **preflight passes.** The call itself 401s on the fake token, and that 401 is *readable* — which is the answer that matters: the browser is allowed to make the preflighted, authenticated write requests the Git Data API needs |
| `x-ratelimit-limit/-remaining/-reset` | exposed to script, so the app can see its own budget |
| `GET /repos/:o/:r/tarball/:ref` | **`TypeError: Failed to fetch`.** The redirect to `codeload.github.com` carries no CORS headers |

So the flagged uncertainty resolves both ways: the API is fully usable, **and the tarball shortcut does not exist**. Search's corpus cannot be one request. It has to be one blob per note — which is the reason the working tree in the browser is not merely a convenience: blobs are addressed by sha and never change under that sha, so a cache keyed on sha refetches only what actually moved, and search reads the cache rather than the network. Without the cache, opening search on a 200-note vault would be 200 requests.

`raw.githubusercontent.com` also answers with CORS, but only for public repositories, and the blob endpoint above is the authenticated path that works for both. There is no reason to use it.

## Registering the App

The settings that are not obvious, recorded because each one is a decision rather than a default.

| Setting | Value | Why |
|---|---|---|
| Owner | Your own account, to start | The consent screen says who the app is *by*, and an organisation reads more credibly to a stranger being asked for write access. Not a one-way door: a GitHub App can be transferred to an org later without users reinstalling |
| Where can this be installed | **Any account** | Without it, nobody but the owner can install — which would be the whole route, closed |
| Request user authorization (OAuth) during installation | **On** | This is what makes the browser's token possible. Installing and signing in become one trip instead of two |
| Expire user authorization tokens | **On** | Eight hours plus a refresh token, rather than a credential that never dies. It costs one more server route and is worth it |
| Webhook → Active | **Off** | Nothing here reacts to a push. GitHub has no channel to a browser anyway, so a webhook would only be useful once a server-side agent exists — and it would need a URL and a secret to sit unused until then |
| Repository permissions | **Contents: read and write**, and nothing else | The Git Data endpoints this route commits with — blobs, trees, commits, refs — all sit under Contents. Metadata: read-only is added automatically and cannot be removed |
| Account permissions | **None** | Not even email. Anything extra invites "why does a notes app need that", and the answer had better not be "convenience" |
| Setup URL | **Not available**, and it should not be | GitHub disables the field once OAuth during installation is on: install, change and sign-in all come back through the one callback instead. Fewer routes, and no second path to keep in step |

Registering the app gives you an App ID, a client ID and a slug. Those three are public by design and go in the server's environment as `GITHUB_CLIENT_ID` and `GITHUB_APP_SLUG`; the **client secret** is the one value that must be kept out of everything, this repository included.

**The private key GitHub offers at the end is not needed, and is worth deleting rather than filing.** It exists to mint installation tokens — the server-to-server shape this route does not use. An unused private key is a credential that can only ever be leaked, never spent.

## What is built so far

Two slices, both on this branch and neither reachable from a shipped build.

**The seam** — `VaultBackend` in `src/web/api/backend.ts`, described in [architecture.md](architecture.md#the-vault-backend). One interface, one place that picks the implementation, and four shapes made neutral that were facts about a filesystem rather than about a vault.

**Reading a real repository** — `src/web/api/github/`, implementing the read half of that interface against the API measured above.

| | |
|---|---|
| The tree | `git/trees/:ref?recursive=1`, once, then rebuilt into the nested shape the file tree wants. Same rules as the server: dot-segments hidden, directories before files, then by name. A `truncated: true` response is an error rather than a partial vault shown as a whole one |
| A file | The blob, with `Accept: application/vnd.github.raw`. **The rev is the blob sha** — a better lock than the mtime this app started with, because it is content-addressed and so cannot drift |
| The cache | Blob text by sha, in memory. A sha names bytes that never change, so it can never be stale — the reason `isSameRev` here is exact equality where the server's needs a millisecond of tolerance |
| Search | One request per note, since the tarball is closed. The cache is what stops that happening twice |
| History | `commits?path=` for the list; the diff comes as a whole commit and the file's part is cut out here, which saves a request per file in a range. **The rows carry no +/− counts** — the list endpoint has none, and fetching them would be one request per row |
| "Modified" | Reads `—`. A blob has no date; the commit list is where "when" lives on this backend |
**The working tree** — `src/web/api/github/store.ts`, and the write half of the interface.

The thing worth recording is what did *not* have to be designed. **The app has never had a working-tree concept**: it has save, uncommitted changes, and commit, and where those live has always been the backend's business. So this slice added no state above the seam, no component, and no control — it is the same four calls with a different implementation behind them.

| The app calls | This server | GitHub |
|---|---|---|
| Ctrl+S → `writeFile` | Writes the file; the disk is the working tree | Writes the store; **the store is the working tree** |
| `gitChanges()` | `git diff` | Diffs the store against the base blobs, here |
| `commit(message)` | `git add -A && git commit` | blobs → tree → commit → ref: every changed file, one commit |
| the five-minute autocommit | A timer in the server process | A timer in the backend |

Details that took a decision:

- **`localStorage`, not the IndexedDB the plan named.** The requirement was that uncommitted work survive a closed tab; `localStorage` does that, is synchronous, is already where drafts go, and can be tested without a browser. What it cannot do — hold megabytes — is not asked of it: this holds *changed* notes between commits, not the vault. A write that ever exceeds the quota throws, and the save reports failure rather than pretending.
- **A moved branch is refused, never overwritten.** The ref update names the commit it expects to replace. If it has moved, the base is refreshed, **every uncommitted edit is kept**, and the panel redraws the diffs against the new version. Pressing Commit again then means "mine wins" — said deliberately, with the other version on screen. The alternative, clearing the store to keep the bookkeeping tidy, would delete the user's work.
- **Revs are `local:` counters while text is only in the store**, and blob shas once committed. Both are opaque above the seam.
- **An empty folder is local and never committed.** Git trees hold no empty directories; that is not a gap to work around.
- **Search reads the overlay**, so text that is saved but not committed is findable — otherwise search answers about a version of the vault nobody is looking at.
- **`ahead` is always 0**, and that is not a stub: a commit lands on the branch, so there is no local history to be ahead of. Both push controls are already gated on `hasRemote && ahead > 0` and disappear on their own. The cost is real and worth naming: **commit is publication here**, with no private amend before anyone sees it.

Tests run against a fake GitHub that keeps a real branch — blobs, trees, commits and a ref that refuses a non-fast-forward — so a test can assert what a commit actually contained, and that a moved branch behaves the way the paragraph above claims.

**The screens, against a stand-in** — `src/web/auth/`. Signing in and choosing a repository are built and tested; the provider behind them is not, because it cannot be: exchanging the sign-in code for a token needs the App's client secret, which is the one thing that cannot live in a browser. `fake.ts` stands in until the App is registered, and swapping it out changes nothing else.

Signing in is one button and no form — no email field, no password rules, no confirmation mail, no forgotten-password flow. Those are GitHub's, and not building them is the cheapest part of this route. The four lines under the button are the screen's content rather than its fine print, and **each is a claim that has to be true of the build**; a test asserts the words are on screen, and the fourth is a link the user can follow rather than a promise they have to take.

Choosing a repository is a list with no filter: it holds however many repositories were ticked on GitHub's own screen, and a search box over three rows is chrome pretending to be a feature. A remembered choice is dropped if the installation stops offering it, rather than leaving the app pointed at a repository it can no longer read.

One thing this forced, and it is an improvement: **`backend` became an object that forwards to whichever implementation is installed.** Which repository is open is not known until someone has signed in and said, so the choice cannot be made before the first render — and the alternative was making all twenty call sites ask for the backend instead of importing it.

### Where the refresh token lives

This was first framed as a choice between an ordinary server session and a stateless server that keeps *"there is no token of yours on my server"* literally true. **That framing was wrong, and it had the sentence driving the security design.**

Held by the browser, a refresh token is a six-month credential sitting in `localStorage`, and any script that ever runs on this origin walks off with it. Held by the server behind an `httpOnly` cookie, a script on the origin can *use* the app while it is running but cannot take anything away from it. The second is plainly safer, and the difference is not close.

So: **the server keeps the refresh token; the browser gets only the eight-hour access token, in memory, never written to storage.** A reload asks the server for a new one.

The sentence then has to change, and the true version is barely weaker — because the part people actually care about is untouched:

> Your notes go from your browser to GitHub. They do not pass through this server.
> Your GitHub session does: this server holds the key that renews it, so it can be revoked from here as well as from GitHub.

Both lines are checkable, and the first one is the claim the architecture was built to make. Trading the neater sentence for a real reduction in blast radius is the right way round; trading it the other way would have been marketing deciding an engineering question.

**Signing in, for real** — `src/server/github-auth.ts` and `src/web/auth/github.ts`.

Four routes, and they are all the server does for this route: start, callback, token, sign-out. It exchanges a code for a token, renews that token, and forgets. **The notes never come near it** — the browser reads and writes `api.github.com` itself, and this exists only because the client secret cannot live in a browser.

| | |
|---|---|
| Access token, eight hours | Returned to the browser, held **in a closure and nowhere else**. A reload loses it and asks again. A test greps `localStorage` and `sessionStorage` for it |
| Refresh token, six months | An `httpOnly` signed cookie, rotated on every use because GitHub issues a new one each time. A cookie that was not rewritten would work exactly once |
| `state` | A signed `httpOnly` cookie, checked on the way back. A callback whose state is not the one this browser was given is not this browser's sign-in, and completing it would attach someone else's account to this session |
| Secure cookies | On everywhere except a `localhost` host, where a browser drops a `Secure` cookie sent over http and sign-in would fail with nothing to see |

One callback route serves signing in, installing, and changing which repositories are shared — GitHub disables the separate setup URL once OAuth during installation is on, and one path is better than two kept in step. The authorize request **names its `redirect_uri` explicitly**: an App may have several callback URLs registered, and left off, GitHub picks the first — which would send a developer on `localhost` to production.

Unconfigured, all four answer 503. `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` must be set together or the server refuses to start: half-configured means sign-in appears to work and fails at the exchange, which is the least debuggable moment to find out. **The single-user deployment sets neither and is untouched.**

**Nothing selects any of this in a built app.** The only way in is a development door gated on `import.meta.env.DEV`, which Vite replaces with `false` at build time. That is a claim about the build, so it is checked against the build: an e2e test greps the shipped bundles for `api.github.com` and for the door's own storage key, and it was confirmed to fail when the gate is removed. The token that door reads is the developer's own, in their own browser, on their own machine — real sign-in mints a short-lived installation token instead, which is the whole reason for using a GitHub App.

## Phase 3 under this route

The direction was already recorded — *"a per-user local binary the server talks to, rather than a process the server spawns"*. Under this route it stops being a compromise.

**Git is the synchronisation primitive.** An agent and an editor never talk to each other; they both talk to the repo. No protocol between them, no server holding both ends, no session to keep in step. And the sentence that makes the trust story work — the notes do not pass through this server — survives having an agent in the picture, which it could not under the original design.

| Agent form | Runs on | Verdict |
|---|---|---|
| A · Local binary on a clone | Their machine | The threat model of any CLI tool. Nothing new to trust |
| **B · In the browser, with their own API key** | Their browser | **Chosen.** No install, works on a phone |
| C · Sandboxed per user on your server | Your machine | Reintroduces exactly the hazard the invariant was written for |

**B was chosen, and it comes with a condition.** The notes reach a model provider, and that has to be stated in the same plain language as everything else:

> When you ask the assistant something, the notes it reads are sent to \<provider\> with your key. They still do not pass through this server.

Both halves are true and the first is the one people need. Said plainly, B is a reasonable trade for not needing an install; left unsaid, it quietly turns a private editor into a client of somebody else's model.

What B still deletes: no sandbox, no container per user, no resource limits for other people's agents, no bill for their tokens.

## Encryption, and where it stops making sense

Three different things get called the same word:

| Level | Protects against | Fits this route? |
|---|---|---|
| TLS, and disk encryption on the host | The wire, a stolen disk | Table stakes |
| Server-side encryption with server-held keys | A stolen disk, and little else — the key is beside the lock | Moot: there is nothing on the server to encrypt |
| End-to-end, key from the user's passphrase | You, your host, your backups, a subpoena | **Contradicts the route** |

The point of keeping notes in your own repo is that they are yours **and legible** — readable on github.com, diffable, greppable, usable without this app. Encrypting them client-side turns the repo into a folder of ciphertext, makes GitHub's own view useless, makes diffs noise, and loses everything if the passphrase is lost. It would be a lock protecting the notes from a server that never sees them.

One accidental synergy worth noting: **search already runs in the browser** and does not care whether the server could read the text. If end-to-end were ever wanted, search is the one feature already in the right place — and the commit panel, which computes diffs on the server, is the one that would have to move.

## What changes in this codebase

- `src/server/vault/` — the filesystem vault becomes a GitHub trees/blobs client in the browser. Path safety, the write lock and the mtime lock all need equivalents against a git tree.
- `src/server/git/` — `simple-git` goes; commit, diff, log and push become API calls. The pending changes panel computes diffs client-side, which it nearly does already.
- `watcher.ts`, `autocommit.ts` — no filesystem to watch, no local repo to commit. Autosave becomes a timed commit through the API: same idea, different code.
- `auth.ts` — one shared password becomes OAuth plus a session per user; `AUTH_PASSWORD` and `SESSION_SECRET` go away.
- The editor, the seven themes, source mode, tables, the phone layout and search are **untouched**. That is most of the app, and the part worth keeping.

## The invariant

`README.md`, [architecture.md](architecture.md) and `.claude/skills/inkstone/SKILL.md` all say this must never be public, and they are right — they were written for the design this route replaces.

If the route is taken, those get **rewritten, not deleted**: the new text should say what the old constraint was, why it existed and what replaced it. A future reader who finds "never expose this" removed with no explanation cannot tell whether it was reasoned about or forgotten.

**And the existing single-user deployment keeps the old rule regardless.** It is still a server with a vault on its disk — which is why this route lives on its own branch, and why `main` is not touched by it.

## Restoring a session, and what the screen shows while it happens

Every load restores before it renders anything, and that costs three round trips: one through this
server to `github.com` for an access token — measured at about 590ms from the deployed host, which
reaches it through a proxy — and two to `api.github.com` for the account and its repositories, at
roughly 360ms each. `/user` and the repository lists go in parallel, which is as short as the chain
gets.

It used to draw `null` for all of it: **about two seconds of blank page on every visit.**

A repository this browser has used before is now enough to draw the whole application immediately,
and the tree arrives into a shell that is already there — the same thing the app does with a note.
That is why `inkstone.repo` stores the whole `Repository` rather than `owner/name`: the backend
cannot be built without the default branch, and fetching it would be the round trip this avoids.
The older form is still read and simply waits, as it always did.

If the session turns out to be gone, `restoreSession` corrects it a moment later and the sign-in
screen appears. A flash of the real interface is a better trade than two seconds of white.
