# The agent — Phase 3

An agent that edits your notes, running **on your own machine**, reached from the app in your browser. Nothing in this phase runs on the server, and the server never learns that any of it happened.

The binary and the browser half are built and work end to end over loopback; the relay that makes
the phone reach a laptop is designed and not built. Everything below is the design and the
measurements it rests on.

**The interface never says "codex".** It says *agent*, everywhere a person can read it — the drawer, the Settings row, the wire format. Codex is the only backend and will be for a while, and everything measured below is measured against it; but the name is an implementation detail of one backend, and a browser that learned it would have to unlearn it in public, across versions of an app that updates itself and a binary that does not. See [The backend seam](#the-backend-seam).

## Why a local binary rather than a server process

The original plan was a codex process spawned by the server with write access to the vault, and it is the reason [architecture.md](architecture.md) says vault mode must never face the public internet. That plan does not survive the public route: there is no vault on the server to write to, and giving a shared server the ability to run an agent against a stranger's repository is a different product with a different threat model.

The notes already live in the user's own GitHub repository and reach the browser directly. Codex already lives on the user's own machine — it is installed, signed in, and has whatever model access they pay for. The only thing missing is a way for the page to talk to it. So: a small binary the user runs, and a browser that talks to it over loopback.

**Nothing about this touches the server.** It is the same shape as the rest of the public route: the browser is the only thing that sees the notes.

## The channel: the binary dials out, the server relays

The first version of this design had the browser calling a server on loopback. It was measured
carefully and it was the wrong shape, because it binds codex to *the machine the browser is on*.
What is wanted is codex bound to **an account**: run the binary on your desktop, and the app routes
to it from anywhere you are signed in — the phone included.

So the binary makes an **outbound** connection to `notes.example.com` and registers a channel; a
browser signed into the same account opens the other end; the server passes bytes between them.

That change deletes every problem the loopback version had, and the measurements are why we know:

| | loopback | relay |
|---|---|---|
| Mixed content — an `https` page reaching `http://127.0.0.1` | blocked in **WebKit**; `ws://` blocked in all three | not applicable: the page only ever talks to its own origin |
| A certificate for loopback | a DNS record and a renewal this project keeps alive **for ever, for everyone** | none |
| Safari, and the phone | Safari unusable; a phone can never reach another machine's loopback | both work |
| Inbound port, NAT, café firewall | listens for connections | dials out; nothing to reach |

The measurements in the loopback version are kept below, because they are what makes this
comparison a fact rather than a preference — and because if the relay is ever unavailable, they say
exactly what the fallback would cost.

<details><summary>What was measured, from <code>https://notes.example.com</code></summary>

| | `fetch http://127.0.0.1` | `ws://127.0.0.1` |
|---|---|---|
| Chromium | **200**, and the `Authorization` header survives preflight | blocked |
| Firefox | **200** | blocked |
| WebKit / Safari | **blocked** | blocked |

Isolating WebKit: an `http` page reaches loopback fine (**200**); an `https` page does not
(**blocked**, mixed content); an `https` page reaches `https://127.0.0.1` fine when the certificate
is trusted (**200**). So it is mixed-content blocking, Safari does not exempt loopback the way the
others do, and the only way through would have been a real certificate for a name resolving to
`127.0.0.1`.

</details>

## Keeping the notes out of the server

A relay means the note text passes through `notes.example.com`, and the sign-in screen says *"your
notes go from your browser to GitHub, never through this server — except a note you choose to
share."* Asking codex about a note is not a deliberate publication, so that clause does not cover
it and should not be stretched to.

**So the server relays ciphertext it cannot read.**

The binary generates a key pair on first run. The **public** half goes to the server and is bound
to the account; the private half never leaves the machine. A browser signed in as that account asks
the server for its agent's public key, generates an ephemeral key pair of its own, and the two
derive a shared key. Everything after that is opaque to the relay.

This is what makes the account model work without pairing every device: **the only thing that has
to travel between devices is a public key, and public keys are safe to hand out.** A phone signed
into the account gets it automatically. Nothing secret is ever stored on the server.

### The one thing this costs, said plainly

The server hands out the public key, so it is trusted **not to substitute one**. It cannot read the
traffic passively — that is the point of the encryption — but a dishonest server could hand the
browser its own key, decrypt, and re-encrypt to the binary. That is an active attack, it leaves
evidence, and the standard answer applies: the binary prints a short **fingerprint** of its key, the
app shows the fingerprint it is actually talking to, and they either match or they do not. One
glance, once. Signal calls the same thing a safety number.

The alternative — a secret pasted onto every device — removes that trust and costs a paste or a QR
scan per device. It is the stronger arrangement and the worse product, and it stays written down
here in case the trade ever needs revisiting.

## Authorising the binary, once, on the machine it runs on

The binary must prove it belongs to the account before the server will bind its key. It has no
GitHub session and should not acquire one.

1. The binary generates its key pair and prints a **short code** — six characters, readable aloud.
2. In the app, already signed in: Settings → Agent → enter the code. The server binds that public
   key to the account and gives it a name — the machine's hostname, so a second one is
   distinguishable from the first.
3. Every browser signed into the account now sees *Agent on Joe's MacBook* and can reach it.

The code is short because it is short-lived and single-use: it authorises one binding, expires in
minutes, and is useless afterwards. It is not a password and never becomes one.

**Nothing is pasted on any other device**, which is the whole point of the account model.

## What crosses the wire

The browser holds the notes; the binary holds codex. So the note text goes from the browser to the binary — from the user's tab to the user's own machine, over loopback.

This deserves saying plainly next to the sign-in screen's promise, which now reads *"your notes go from your browser to GitHub, never through this server — except a note you choose to share."* The agent adds no clause to it: loopback is not "through this server", and the server neither sees nor knows. But the app should say, where the agent is turned on, that the note is being handed to a program on this machine.

## One note at a time, which is also the sandbox

The binary has no repository — the browser holds the notes. So a request carries one note's text and
a prompt, and the binary builds an **ephemeral working directory containing exactly that one file**,
runs codex with that directory as its root, reads the file back, and deletes the directory.

Scoping codex to a single note is the simpler product, and it keeps the *vault* out of reach: the
rest of the notes are not there, so nothing can touch them.

**It is not, on its own, a box around one file.** That claim was written here before it was
measured, and measuring it proved it wrong — see below.

The cost is real and worth stating: codex cannot look at a neighbouring note for context, and
"rename this across all my notes" is not a thing this can do. That is the trade, taken deliberately.

**The note is the workspace.** That is the whole of it: one file, in a directory made for this run,
which codex may edit because editing a file is what codex is for. The binary reads the file back
afterwards and hands the text to the browser as a proposal.

### What `workspace-write` actually permits, measured

Run against codex 0.147.0 on macOS, with every flag above, and verified from outside rather than
taken from the model's own account of itself:

| Attempted | Result |
|---|---|
| Write the note inside the working root | **allowed** — which is the point |
| Write `/tmp/…`, outside the working root | **allowed** |
| Write `~/inkstone-probe.txt` | **refused** — and independently confirmed absent |
| Read `~/.zshrc`, outside the working root | **allowed** |
| `curl https://example.com` from a shell command | **blocked** |

So the real boundary is: **writes to the workspace and the system temp directories, reads of
anything the user can read, and no network from shell commands.** The home directory is safe from
writes. It is not safe from being read.

### Which halves of that are configurable, and which is not

Config keys validated against codex 0.147.0 with `--strict-config`, which rejects an unknown field
before contacting the model — so this cost nothing, and a deliberately bogus key was used as a
control each time, because two earlier attempts at the same check "passed" everything including the
control.

| Key | |
|---|---|
| `sandbox_workspace_write.writable_roots` | **exists** — writes can be pinned to what we choose |
| `sandbox_workspace_write.exclude_tmpdir_env_var` | **exists** — closes `$TMPDIR` |
| `sandbox_workspace_write.exclude_slash_tmp` | **exists** — closes `/tmp` |
| `sandbox_workspace_write.network_access` | **exists** — the shell network block, explicitly |
| `tools.web_search` | **exists** — search as config rather than a flag |
| `sandbox_workspace_write.readable_roots` | **does not exist** |
| `sandbox_read_only.readable_roots` | **does not exist** |
| `sandbox_permissions` | **does not exist** (the help text's example is stale) |

**Writes can be closed to exactly the workspace. Reads cannot be narrowed at all.** There is no
key for it, so the broad read is a property of codex's sandbox rather than a setting we have
declined to change.

That makes the position honest and simple: the temp-directory holes get closed because closing them
is free, and the read stays open until something other than codex's own sandbox contains it.

That is worth sitting with, because it is the same access the user already grants codex every time
they run it in a terminal. What is new is not the access — it is that **a web page can now trigger
it**, which is what the pairing token exists to make specific.

**And it puts a condition on `--search`.** Shell commands have no network, so nothing the model reads
can leave the machine that way. `web_search` is performed by the model's runtime, not by a shell, so
it is not blocked — and the model's context by then may contain whatever it has read. Read
everything, then search for it, is a path off the machine that exists only when both are on.

**Search is wanted first**, which settles the argument in the other direction: the exfiltration path
is not hypothetical any more, so the thing to fix is the *read*, not the search.

The writes get closed now, because that is three config keys and costs nothing. The read cannot be
closed by configuration — there is no key — so it takes a sandbox of our own around codex, and
under a search-enabled design that stops being an open question and becomes a **prerequisite**.

Until it exists, the honest sentence next to the switch is that the agent can read what you can
read, and that search is the route by which what it reads could leave.

### A prompt shapes behaviour; it does not enforce anything

The prompt should absolutely say what is wanted — edit this note, do not run commands, do not reach
outside this file. That is worth writing carefully, and it is how the good case is made to happen.

**It cannot be the boundary, because the note goes into the prompt.** Whatever is in the note is
text the model reads, and a note can contain a sentence addressed to the model. Nobody has to be
attacking anyone for this to bite: people paste things into notes — a README, an error message, a
web page, someone else's shared note saved from a link. The sandbox is what makes the difference
between "the model was asked nicely" and "the model could not have done otherwise".

So both, and each for its own job: **the prompt for intent, the sandbox for permission.** If the
sandbox is ever relaxed on the grounds that the prompt already says not to, that is the moment this
design stopped being safe.

### The command line, and why each flag is there

Measured against `codex 0.147.0`. Every one of these is a decision, not a default:

| Flag | Why |
|---|---|
| `exec` | Non-interactive. A daemon cannot answer prompts |
| `-C <tmpdir>` | The working root: one note, and nothing else |
| `-s workspace-write` | The narrowest mode that still lets codex edit the note. **Not as narrow as its name suggests** — measured below |
| `--ignore-user-config` | **The one that is easy to miss.** A user's `~/.codex/config.toml` may carry `sandbox_permissions=["disk-full-read-access"]` or `shell_environment_policy.inherit=all` — settings they chose for themselves, interactively, which must not silently widen what a *web page* can drive. Authentication still comes from `CODEX_HOME`, so this costs nothing but the loosening |
| `--ignore-rules` | Same reasoning for execpolicy `.rules` |
| `--ephemeral` | No session files on disk. The conversation lives in the binary's memory, and dies with it |
| `--skip-git-repo-check` | The working root is a temp directory, not a repository |
| `--json` | JSONL events on stdout, which is what the stream to the browser is made of |
| `-o <file>` | The final message, read back after the run |
| `--search` | The first capability asked for, and the one that makes the read boundary matter — see below |
| `-c sandbox_workspace_write.exclude_slash_tmp=true` | Closes `/tmp`, which `workspace-write` otherwise leaves writable |
| `-c sandbox_workspace_write.exclude_tmpdir_env_var=true` | Closes `$TMPDIR`, for the same reason |
| `-c sandbox_workspace_write.writable_roots=[<the workspace>]` | Says the workspace and means it |

And one that must never appear: **`--dangerously-bypass-approvals-and-sandbox`**. It exists for
environments that are sandboxed from the outside. This is not one, and a flag with that name in a
program driven by a web page would be indefensible.

`--approve-for-me` — automatic approval routed through review, inside `workspace-write` — is the
obvious next question and is deliberately not answered yet. It widens what a prompt can do without a
person present, which is exactly the decision that should not be made in passing.

## Two kinds of request, told apart by what changed

A person asks codex for two different things, and the interface has to know which happened:

- *"Explain this section to me"* — an **answer**. Nothing about the note should change.
- *"Polish this"*, or *"add this link to the document"* — an **edit**. The note comes back different.

The obvious approach is to make the model declare which one it did, in JSON. **Do not.** A contract
the model has to remember is a contract it can forget, and the failure is silent: an edit reported
as an answer is a change that quietly does not reach the note.

**We already know.** We wrote the file into the workspace, so we have it before and after:

| | |
|---|---|
| The file is unchanged | An answer. Show `-o`'s final message as text |
| The file differs | An edit. Show the diff, with Apply and Discard |
| Both | It changed the note *and* said something. Show both — the sentence above the diff |

Nothing is asked of the model, so nothing can be got wrong. The prompt still says which was wanted,
because that is how the right thing is made to happen; but the *classification* is an observation,
not a promise.

`codex exec --output-schema <FILE>` exists and takes a JSON Schema for the final response. It is
worth keeping in mind for the day an answer needs structure — citations from a web search, say — and
it is not needed for this, because this is answered by two files and a comparison.

## What a run looks like while it happens

Measured against real codex: **eleven seconds before it says anything, thirty-one to finish.** That
is far too long to spend behind a spinner, so the drawer watches it work:

```
  +11.1s  said     我先查看 note.md 的内容与结构，再在文末做最小幅度补充。
  +14.2s  ran      /bin/zsh -lc "sed -n '1,240p' note.md"
  +19.6s  edited   note.md
  +21.9s  said     已在文末添加「延伸阅读」…
  +21.9s  done
```

Four kinds, and they are **not codex's own event shapes**. Codex emits `item.started` and
`item.completed` wrapping an `item.type` of `agent_message`, `command_execution` or `file_change`;
those belong to a program that will change them, and anything unrecognised is dropped here rather
than forwarded, so a new event type in a codex release is invisible instead of surprising.

`ran` is in that vocabulary for trust rather than progress. **An agent running a command on your
machine should say so while it does it** — the sandbox is what makes it safe, and seeing it is what
makes it believable.

## The backend seam

Codex is one backend, not the feature. `src/agent/backend.ts` is a type and a list that currently
holds one:

```ts
export interface Backend {
  id: string        // 'codex' — stable, lowercase, shown to nobody
  label: string
  detect(): Promise<BackendPresence>
  run(request: RunRequest, onEvent: (event: RunEvent) => void): Promise<RunResult>
}
```

Everything codex-shaped lives under `src/agent/backends/` — how it is found, how it is run, and
which of its flags are load-bearing. `startAgent` takes `backends: [codexBackend()]` and imports
none of it.

Deliberately **not** a registry, a plugin loader, or a capability negotiation. When there is a
second backend, the differences between the two will say what the abstraction actually needs to be;
guessing that now would be guessing. What the seam buys today is only the thing that is expensive to
change later — the wire format, which is plural from the first version:

```json
{
  "agent": "inkstone-agent",
  "machine": "Joe's MacBook",
  "backends": [
    { "id": "codex", "found": true, "version": "0.147.0", "path": "/opt/homebrew/bin/codex" }
  ]
}
```

`backends`, not `codex`, and a list rather than an object. A browser that learned either the word or
the singular would have to unlearn it in public, across versions of an app that updates itself and a
binary that does not. The event kinds (`said` / `ran` / `edited` / `done`) are already ours rather
than codex's own shapes, for the same reason and by the same argument as the streaming section
above.

An entry that is not installed **stays in the list** with `found: false` rather than being dropped
from it. "I do not run that" and "that is not installed here" are different faults with different
fixes, and the interface has to be able to say which.

A `capabilities` field was drafted and cut. It is worth recording, because it is the same mistake
one size down: it described a difference that does not exist — web search was the example, and there
is no agent worth wiring up that cannot search the web. **The plural belongs in the shape, not in
machinery for differences nobody has seen yet.** The search toggle is unaffected, because it was
never a capability question: it is the one path where a note leaves the machine, which is a choice
the person makes rather than a feature the backend has.

Two places may still name a backend, and both are correct. The **terminal** the binary prints to,
because the person reading it installed it and is diagnosing their own `PATH`. And **this document**,
because every measurement here was taken against `codex 0.147.0` and attributing them to "the
backend" would make them unreproducible.

## Choosing between backends

Two things vary and a person picks one pair: **which machine** and **which backend on it**. A
machine is a place; a backend is a tool. They are shown as one list grouped by machine rather than
two dropdowns, because two dropdowns to start a sentence is a tax paid by everyone to serve the few
who own three computers.

**When there is one, there is no picker.** The common case — one laptop, one backend — sees a
version number and nothing to click. The control appears only when there is something to choose. The
drawer header already reads *Agent · Joe's MacBook*; that line becomes the control, because it is
already the line that answers "where is this running".

| Rule | Why it is a rule and not a preference |
|---|---|
| **The browser names the backend on every run** | The binary never picks and never substitutes, even when there is only one to substitute. An unnamed backend is `400`, an unknown one `404`, an uninstalled one `409` — never a fallback. A note run through a model the person did not choose is the quietest possible way to break the promise this phase is built on |
| **Switching starts a new conversation** | A session belongs to one backend. Carrying a transcript across asserts a continuity that does not exist |
| **The choice lives in the browser, not the binary** | It is a property of the person, not the machine. The binary holds *no* state that survives a restart — no repository, no token, no preference — and that is worth keeping true. So there is no `default` on the wire: it would be the binary holding an opinion about a person, and two machines' copies would disagree |
| **Absent backends are named once, in the empty state** | Not offered in the picker, because offering what cannot run is noise. But "found nothing" has to be diagnosable |

Detection runs once, at startup, so a prompt never waits on `which`. A backend installed while the
binary is running is not seen until it is restarted — the same rule as a shell.

The sketches, desktop and phone, are in the design artifact.

## More than one turn

Each prompt used to run in an ephemeral workspace with no memory of the last, and the drawer showed
a single turn and said so — a scrolling chat log would have asserted a continuity that did not
exist. It exists now.

**One conversation per note, and they all stay alive.** Open a note and the drawer shows that note's
conversation; open another and it shows that one's; come back and the first is intact. An earlier
draft had one conversation at a time plus a state for *"the open conversation is about
coroutine.md"* and a button to start one for the note actually on screen. **That state does not
exist, and neither does the button** — nothing has to be switched, abandoned or confirmed, because
nothing was ever pointed at the wrong document.

### The binary owns the sessions

Not split with the browser. The browser holds no session id and sends none: a run already carries
the note's name, the binary keys on it, finds or opens the conversation, and answers.

An id in both halves is one fact in two places that can disagree — a tab reloading with a stale id,
an id for a session that expired, a browser certain a conversation exists after the binary was
restarted. None of those states exist if the browser never holds one. Two things fall out of it:
**the memory outlives the tab** (reload and the transcript is gone, but the next question still
remembers), and **sweeping has one owner**, where the workspaces and the thread files are.

| | |
|---|---|
| `GET /sessions` | which notes have one, and how many turns |
| `DELETE /session` | what *New* does |
| `POST /run` | unchanged on the wire: `title` is also the session key |

`src/agent/sessions.ts` is the first state in the binary that outlives a request, which was a
deliberate property until now. Bounded three ways: a cap of 8 notes, a 30-minute idle timeout, and
the process. Swept when somebody asks rather than on a timer — a timer keeps a process awake to
delete directories nobody is waiting on.

### What it cost, measured against codex 0.147.0

| Fact | Consequence |
|---|---|
| `codex exec resume <id>` exists; `thread.started` carries the id | Nothing had to be invented |
| **`--ephemeral` had to go** — its whole job is *"run without persisting session files to disk"* | The conversation, **including the note's text**, is written to `~/.inkstone/codex-home/sessions/`. What that flag used to buy is bought instead by deleting the thread file with the conversation that owns it |
| `resume` refuses `-s` and `-C` | The mode goes through `-c sandbox_mode="workspace-write"`, and the working directory comes from the spawned process. **Checked rather than assumed**: a resumed turn told to write to `~` answered *"Denied: operation not permitted"* and no file appeared |
| The workspace was deleted after every run, with a test asserting it | It outlives the turn now, because a resumed session refers to a file that would otherwise be gone. The invariant moved from *one request* to *one conversation* |

**The note is re-seeded from the buffer at the start of every turn**, and the model is told when it
changed. Between two turns the reader can accept a proposal, type, or have the file change
underneath — so "now make it shorter" must not run against a version nobody is reading. The same
rule settles the diff: a proposal is measured against the note as it stood at the start of *that*
turn.

**A run belongs to its note, not to the drawer.** Leaving a note while the agent works does not
cancel it; the answer lands in that note's conversation. Anything else would make "look at something
else for thirty seconds" cost the run.

The preamble is sent in full only on the first turn. A resumed turn already has it in context, and
repeating it spends the window on instructions the model has read four times — which comes back out
as nagging in the answers.

### Waiting is thirteen seconds of nothing

Measured: **13.4s before the first event**, 22.2s to finish, and 9.7–14.2s on a resumed turn. A
motionless "Working…" over that is indistinguishable from a hang — somebody watched one and pressed
Stop. It counts now, and says what normal looks like (`Working… 7s · usually 10–30s`) so nobody has
to learn the range by waiting twice. The range disappears past 40s, where it stops being
reassurance and becomes an alibi.

Two things came out of that report and neither was a speedup, because the time is the model's:

- **Stop only stopped the display.** The process ran to completion and spent the reader's own quota
  on an answer nobody would see. The disconnect is forwarded now — `res.on('close')` → an
  `AbortSignal` → `SIGTERM`, not `SIGKILL`, so codex closes its session file cleanly rather than
  leaving a half-written one for the next resume to read.
- **Stopping showed a browser's internal string.** `BodyStreamBuffer was aborted`, in red, where an
  answer should have been. Stopping is something the reader did on purpose; it says *Stopped.* And
  nothing that is not ours reaches the screen verbatim any more.

### One bug worth keeping

`new Sessions()` was constructed without a `home`, so `forgetThread` received null and returned
silently: every note's text stayed on disk after the conversation was ended. **The test passed**,
because it called `forgetThread` directly rather than driving it through `drop` — it tested the
function and not the wiring. It is now driven through `drop`, and the fix was found by counting
files on disk after a real run rather than by reading the suite.

## What is built, and how it was checked

The browser half lives in `src/web/agent/` (transport and diff), `src/web/state/agent.ts` (the two
rules above, so no component can forget them), and `AgentPanel.tsx`. The drawer gained a second tab
beside History; the phone reaches the same panel as a sheet, beside Outline and History. Settings
gained the one row.

Verified against real codex through the real UI, not only against tests:

| | |
|---|---|
| **Streaming** | first text at +12.1s, `ran` at +14.1s, `edited` at +18.2s, the answer at +19.2s, the result at +28.2s. A spinner over that is indistinguishable from a hang |
| **A proposal, not a write** | word count 11 → 23 on Apply, and the file on disk unchanged at 5 lines |
| **Two display faults, found by watching the timeline rather than by reading the code** | `done` rendered as "Finished" *before* the result arrived, so the panel said "Finished" and "Working…" at once; and the final answer printed twice, because the last thing the model says **is** the answer |
| **Apply saves** | A deliberate exception to manual-save-only, and not a contradiction: Apply *is* the deliberate act. The reader has read a diff and pressed a button that says Apply; asking for Ctrl+S then asks twice for one decision, and the note that sits unsaved in between is the one place an agent's work is lost to a closed tab |
| **No web-search toggle** | There is no agent worth wiring up that cannot search, so the box was a tax every prompt paid to describe a choice nobody was making. Search is always on; what crosses the wire is unchanged and still says so beside the sign-in promise |

### The user's own codex home does not come with it

A run asked to append a sentence to a note instead ran
`sed -n '1,240p' ~/.codex/skills/english-tutor/SKILL.md` and put **📝 English Feedback** in the
answer. A personal skill, loaded from the user's own codex home, changing what a request driven by a
web page does.

The skill was the visible half. `skills/` held seventeen more, and beside it sit `rules/`,
`AGENTS.md`, `hooks.json`, `plugins/`, `memories/` and `superpowers/` — every one configured by the
user for their own interactive use, and none of them something a prompt typed into a drawer should
reach.

**Nothing in codex turns this off.** Measured against 0.147.0, with a bogus control key alongside so
a blanket rejection could not read as a result:

| Tried | |
|---|---|
| `skills.enabled`, `tools.skills`, `use_skills`, `features.skills` | do not exist — `--strict-config` rejects each as an unknown field, and rejects the control key too |
| `skills=[]` | the field **does** exist and the override is accepted. The skill still loaded and the model still read it |
| `--ignore-user-config` | skips `config.toml` only, and its own help says *"auth still uses `CODEX_HOME`"* |

So the lever is the variable. The binary keeps `~/.inkstone/codex-home/`, containing an `auth.json`
**symlinked** to the real one and nothing else, and spawns with `CODEX_HOME` pointed at it. Verified
against a live run: it authenticates, and the skill is gone.

Symlinked and never copied, because this process must not read, write or hold a copy of anyone's
token — codex opens the link and gets the real file. The link is checked and repaired on every run
rather than created once: if a token refresh replaces the file rather than writing through it, the
symlink becomes a regular file and the real credential silently stops being updated. The cost of
repairing over a newer token is one re-authentication. The cost of not checking is a credential
diverging in two places.

### Two things the model said that it should not have

Both were fixed in the preamble and at the boundary rather than left to chance:

- **Narrating the setup back at the reader.** *"The English-tutor skill file is outside the
  permitted directory, so I won't access it."* *"Your request is already clear; a slightly smoother
  phrasing is…"* The reader did not write these constraints, cannot act on them, and did not ask to
  have their own sentence graded. The preamble now forbids commenting on the instructions, on what
  is reachable, and on the request itself.
- **Linking into the workspace.** An answer came back as
  `[welcome.md](/var/folders/…/inkstone-codex-0njdCA/welcome.md)` — a link into a directory deleted
  seconds later. The model cannot know the workspace is disposable, so every event and every answer
  is scrubbed on the way out: a markdown link collapses to its text, a bare path becomes the note's
  name.

### The note keeps its own name

The workspace file was `note.md` always, and the answers said so about files the reader knows by
another name. A title is part of a note — a heading is often written to agree with it — so
withholding it made the model work from less than the reader could see. Only the basename is used,
and only after path separators, control characters and leading dots are removed.

Denylist, not allowlist: the first version allowed letters, numbers, space, dot, dash and
underscore, which turned `C++ coroutines.md` into `C coroutines.md`. Punctuation is ordinary in a
note's name and mangling it is the same fault as not passing the name at all.

### Two more came out of measuring rather than looking:

- **`opacity: 0.45` on a filled button is a button with nothing written on it.** It fades the white
  label and the fill toward the page at the same rate. A muted fill with a solid muted label reads
  as unavailable and stays readable.
- **`--ink-code-bg` is a code-block colour, and two *light* themes set it to something dark** —
  Tailwind's is `#1e293b`, Aspartate's is `#282a36`. Filling the diff with it puts dark text on a
  dark ground. The history panel next door has never had this problem because it uses colour and no
  fill; this now matches it. Measured across all seven themes in both appearances afterwards.

One thing measuring found and this did **not** change: everforest's light `--ink-link` is `#8da101`,
and white on it is 2.41:1. That is the app's filled-button convention in nine places, not something
this feature introduced — worth fixing, but as its own decision rather than inside this one.

## What the binary actually does

| | |
|---|---|
| **Finds its backend** | Looks for it on `PATH`, reports the version, and says so plainly when it is missing rather than failing at the first prompt |
| **Runs a session** | `codex exec` in an ephemeral directory holding one note. See the flags above — every one of them is load-bearing |
| **Keeps sessions** | Conversations outlive a page reload, because a browser tab is not a good place to keep an agent's memory |
| **Streams** | Newline-delimited JSON on a chunked response. `EventSource` cannot carry an Authorization header or a body, so the browser reads this with `fetch` and a stream reader either way — and once you are parsing the stream yourself, SSE's framing is ceremony |
| **Returns edits as a proposal** | Never writes anything. It hands back the text it would write |

That last one matters most. **The binary has no repository, no token and no way to save anything.** The agent proposes; the browser is what applies an edit, through the same backend and the same commit panel as a human edit. An agent's change should arrive as an uncommitted change like any other, and be reviewed before it enters anyone's repository.

## Where it lives in the interface

The right drawer, which has been reserved for this since Phase 2 and currently holds nothing — see [layout.md](layout.md). On a phone it is a sheet, beside Outline and History.

Settings gains one row: *Agent* — the agents bound to this account and their fingerprints, with the
short-code field behind it. That is the whole footprint. Under the first principle, a feature this
size earns exactly one new row and one drawer that already exists, and nothing in the top bar.

**The phone is a first-class client here**, which is the whole reason the design changed. It reaches
the same agent as the desktop, and the drawer names the machine it is talking to — *Agent on Joe's
MacBook* — because "which computer is this running on" is the one thing a phone user cannot infer.

That makes a new state the common one rather than an edge case: **the agent is bound but not
running**, because the laptop is shut. The phone will meet it constantly. It is a different sentence
from "no agent has ever been set up", and it needs no button, because nothing the phone can do will
wake the machine.

## What this is not

- **Not a chat product.** One conversation about the note in front of you.
- **No agent on the server, ever.** If the binary is not running, the drawer says so and offers the download. It does not fall back to anything.
- **No writes from the binary.** Proposals only. The commit panel is still where changes enter a repository.
- **No discovery.** No port scanning, no mDNS, no "find my binary". A pairing string, pasted once.

## Getting it onto each user's machine

**Distribution.** Measured on macOS: only a Homebrew *cask* arrives carrying
`com.apple.quarantine` — codex itself does, and runs only because OpenAI signs and notarises it.
A file fetched by `curl`, by `npm`, or by a Homebrew *formula* carries no quarantine at all. So an
install line or an `npx` avoids signing and notarisation entirely, and the audience for this
already has a terminal open, because codex is a CLI. The binary can be served from
`notes.example.com` itself, which also sidesteps a private repository having no public releases.

**Running it.** In the foreground, printing its pairing string, stopped with Ctrl-C — the same
shape as codex. A daemon flag can come later; it should not come first, because a background
process holding an agent open is a thing people should choose deliberately.

**Per machine.** Each user runs their own binary and gets their own token. Nothing is shared, and
there is no account anywhere in it.

### The sandbox attempt, and where it stopped

Wrapping codex in macOS Seatbelt was tried, since configuration cannot narrow the read. A profile
that denies reads of `$HOME` while allowing `CODEX_HOME` and the workspace does work in itself —
verified directly: `cat ~/.zshrc` is refused inside it, the workspace stays readable and writable,
and `codex --version` runs.

**But `codex exec` does not.** It fails with `Operation not permitted` before producing any event,
and it still fails when the profile is loosened to allow `~/Library`, and when codex's own sandbox
is turned off with `-s danger-full-access`. No denial was captured in the system log. Whatever it
needs, a Seatbelt wrapper is not giving it, and the cause was not found.

It was the wrong tool regardless: Seatbelt is macOS-only, so it could never have been the answer for
anyone else. **A container is the portable version of this idea and is where it should be picked up**
— which is a project, not an afternoon.

Until then the constraint is the prompt, which is a real constraint on behaviour and no constraint at
all on capability. The measured facts stand: the agent can read what the user can read, and
`web_search` is the route by which what it reads could leave. That sentence belongs beside the
switch, in the interface, not only here.

### What the certificate section used to say

An earlier draft of this document spent a long section on obtaining a real certificate for a name
resolving to `127.0.0.1`, because Safari refuses to let an `https` page reach `http://localhost`.
**The relay removes that problem entirely** — there is no loopback listener, no certificate and no
DNS record, and nothing this project has to keep renewing for every user for ever.

It is worth remembering only as the shape of the fallback: if a relay is ever unacceptable, that is
what the alternative costs.

## Open, and to be settled before building

1. **What the relay holds while a session runs.** Bytes in flight, and nothing else, is the goal —
   but a reconnecting phone needs *something* to reconnect to, and how long that something lives is
   a number nobody has picked.
2. **What happens when the laptop shuts mid-answer.** The phone should learn that promptly rather
   than waiting on a stream that will never continue.
3. **Whether one account may bind several machines.** A desktop and a laptop is an obvious want; it
   turns the drawer's title into a picker, which is chrome, so it needs to be worth it.
4. **Idle sessions.** Holding a codex session open is not free. The binary needs a policy and the
   policy needs a number.
5. **What `codex exec` does when an action needs approval and nobody is there.** The intended
   scope — a prompt, a note, and an edited note back — should never reach for one. It should refuse
   rather than hang if it ever does, but that is an assumption until it is run, and running it costs
   model quota on somebody's account.
6. **Whether `workspace-write` permits network access** from commands the model runs. `--search` is
   a separate, deliberate switch; this is about whether the sandbox leaves another way out.
7. **Windows.** All of this is written as though the user is on macOS, because that is what this
   deployment is.
