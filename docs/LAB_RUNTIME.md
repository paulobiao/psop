# PSOP Local Lab Manager — Speco Runtime Selection

The local lab manager (`pnpm lab:start` / `lab:status` / `lab:stop`,
implemented in `scripts/lab/`) brings up PostgreSQL, the API, the
Dashboard, the Lorex gateway, and the Speco NVR watcher for local
development and for the physical lab (a real Speco N8NRL NVR and its
Hikvision child cameras).

This document explains why the Speco watcher — and only the Speco
watcher — has an explicit, fail-closed runtime selection instead of just
running whatever code happens to be on disk, and why its **code** and its
**local config** are resolved from two entirely independent directories.

## Development workspace vs. runtime worktree

Every other service the lab manager starts (API, Dashboard, Lorex) runs
out of whichever worktree `scripts/lab/` itself lives in — call this the
**development workspace**. That's fine for them: if they're a few commits
behind, the worst case is a developer notices stale behavior in a local
UI.

The Speco watcher is different. It is the process that decides, in real
time, whether a physical NVR and its cameras are online — and that
decision feeds alerts and operational history. Running it out of
whatever branch a developer happens to have checked out for unrelated
work is not a convenience, it's a liability: the code driving that
decision can silently drift out of date while the developer keeps
editing other files in the same worktree.

For this reason, the Speco watcher gets its own concept: the **runtime
directory** — an explicit directory containing `speco_n8nrl.py`, resolved
independently of wherever `scripts/lab/` lives, validated before every
start, and never defaulted silently.

## The incident that motivated this

On 2026-09-02, a Speco NVR was physically powered off for several hours
in the lab. The dashboard kept showing it `ONLINE`, with three dependent
cameras `UNKNOWN` and three "not reporting normally" alerts. Forensics
found:

- The running watcher process (`speco_n8nrl.py --watch`) had been started
  from the development workspace's `apps/gateway/`, which was checked out
  several commits *behind* a fix for exactly this class of bug (a
  stale-heartbeat fix that had already been merged to `main` days
  earlier, on a different branch/worktree).
- The pre-fix code sent an NVR's own heartbeat as `status: online`
  unconditionally, regardless of whether the current collection cycle
  actually reached the recorder — it only ever downgraded
  `collectionState`, never the reported connectivity.
- The database confirmed it: `observed_at` kept advancing every ~30s
  while the NVR was provably unreachable over the network (100% packet
  loss, `Host is down` on every relevant TCP port). No `HEARTBEAT_OVERDUE`
  event was ever raised.
- Nothing in the lab manager detected or warned about this. `lab:start`
  had no way to know the code it was about to run was stale, and no way
  to point at a different, known-good directory even if a developer
  wanted to.

Cutting over to a worktree that actually contained the fix immediately
produced the correct behavior: `observed_at` froze, the Health Engine
raised `HEARTBEAT_OVERDUE` and flipped the NVR to `OFFLINE` within one
polling cycle margin, and the three dependent cameras correctly stayed
`UNKNOWN` rather than receiving a fabricated `OFFLINE`.

The runtime-selection design in this document exists so that this
specific failure mode — a stale, silently-selected runtime running
against real hardware — cannot recur unnoticed.

## Two independent directories

An earlier version of this design required a symlink trick (config files
symlinked into the runtime directory, because `speco_n8nrl.py` used to
resolve its own config relative to its own file location). That coupled
"what code runs" and "where the config lives" in a way that could pass
validation with a symlink present and a real file missing behind it, and
made a code-only runtime directory impossible.

`speco_n8nrl.py` now accepts an explicit `PSOP_SPECO_CONFIG_DIR`
environment variable. With it unset, behavior is unchanged (config is
read from next to the script, for standalone/manual use). With it set,
config is read from that directory instead — independent of where the
script itself lives:

```
Development/Lab Config:
  <config-dir>/apps/gateway/
    .env.speco.local
    speco.local.json

Stable Runtime:
  <runtime-dir>/apps/gateway/
    speco_n8nrl.py
```

```
PSOP_SPECO_RUNTIME_DIR=<runtime-dir>/apps/gateway
PSOP_SPECO_CONFIG_DIR=<config-dir>/apps/gateway
```

No symlink is required or expected. A runtime directory is validated as
code — it does not need to contain (or link to) any config file at all
to pass its own checks.

## Setup

1. Pick (or create) a directory containing a working checkout of
   `apps/gateway/` for the runtime — this can be the development
   workspace itself while you're actively testing a gateway change, or
   (recommended for the physical lab's steady state) a dedicated, clean
   worktree tracking `main` — see "Dedicated runtime worktree" below.
2. Point `PSOP_SPECO_CONFIG_DIR` at wherever `.env.speco.local` and
   `speco.local.json` actually live (typically your development
   workspace's `apps/gateway/`, unchanged from before this design
   existed) — see "Precedence" below.
3. Point `PSOP_SPECO_RUNTIME_DIR` at the runtime directory from step 1.
4. Run `pnpm lab:start`.

## `runtime.env`

A local, git-ignored file at `.psop-lab/runtime.env` (next to the
existing `.psop-lab/pids/` and `.psop-lab/logs/`, all covered by the same
`.psop-lab/` `.gitignore` entry). Format is plain `KEY=value` lines, one
per line; only two keys are ever read, and the file is **never
sourced/eval'd** — a small hand-written parser only accepts those two
exact keys, so a typo or an unexpected line is simply ignored rather than
executed as shell.

```
PSOP_SPECO_RUNTIME_DIR=<runtime-dir>/apps/gateway
PSOP_SPECO_CONFIG_DIR=<config-dir>/apps/gateway
```

`PSOP_SPECO_CONFIG_DIR` is optional — see "Runtime vs. config" below.

No personal absolute path is ever written into a versioned file: this
file is the only place a machine-specific path lives, and it is
git-ignored.

## Precedence

Resolved in this order, for both the runtime directory and (independently)
the config directory:

1. **Environment variable**, set explicitly for the current shell/session
   (`PSOP_SPECO_RUNTIME_DIR`, `PSOP_SPECO_CONFIG_DIR`) — highest priority,
   useful for a one-off override without touching the persisted file.
2. **`.psop-lab/runtime.env`** — the normal, persistent way to configure
   this once per machine.
3. **Fallback** — see below. The runtime directory and the config
   directory are treated differently here.

## Fail-closed

`lab:start` only starts Speco when **both** independent checks pass, plus
a Keychain password:

```
speco_runtime_check(RUNTIME_DIR) == OK
AND
speco_config_check(CONFIG_DIR)   == CONFIG_OK
AND
a password is available in the Keychain
```

If neither (1) nor (2) above resolves a runtime directory, `lab:start`
**does not** fall back to `$REPO_ROOT/apps/gateway`. It refuses to start
the Speco watcher, prints exactly why, and continues bringing up the
other services (a missing/invalid Speco runtime or config is reported,
not fatal to the rest of the lab — consistent with how a missing
Keychain password is already handled today).

```
==> Speco NVR watcher
    Speco runtime is not ready — refusing to start (fail-closed).
    Speco runtime is not configured (set PSOP_SPECO_RUNTIME_DIR, or add it to .psop-lab/runtime.env)
    Configure it once with either:
      export PSOP_SPECO_RUNTIME_DIR=/path/to/runtime/apps/gateway
    or add a line to .psop-lab/runtime.env:
      PSOP_SPECO_RUNTIME_DIR=/path/to/runtime/apps/gateway
    See docs/LAB_RUNTIME.md. Skipping Speco watcher.
```

If the runtime check passes but the config check fails (e.g. the mapping
file is missing), the same fail-closed refusal happens for that reason
instead — never a partial start that lets the Python process fail later,
mid-collection, after `lab:start` already reported success.

This is deliberate: this lab has already had a stale-runtime incident
against real hardware. A one-time configuration step is a small price for
never again silently running unknown code — or code with an incomplete
configuration — against a physical NVR.

The **config** directory (`PSOP_SPECO_CONFIG_DIR`) has a safe default —
`speco_config_dir_resolve()` falls back to `$REPO_ROOT/apps/gateway` (the
development workspace's existing local config) if unset — but the
**content** of that directory is still validated by `speco_config_check`
and is just as fail-closed as the runtime check: a config directory
missing either file refuses to start Speco. The distinction is only about
*locating* the directory (config gets a sensible default; runtime code
never does), not about validating what is found there.

## Runtime (code) guard

Before starting Speco, `lab:start` checks that the resolved **runtime**
directory:

1. exists;
2. contains `speco_n8nrl.py`;
3. is inside a valid git worktree;
4. has the minimum required fix commit as an **ancestor** of its `HEAD`:

   ```sh
   git -C "$SPECO_RUNTIME_DIR" merge-base --is-ancestor \
     2ff1239292461bba2bde2c5af7a248cbda275d05 \
     HEAD
   ```

5. is **not dirty** (`git status --porcelain` is empty — see below).

This check is about **code only** — it does not look at
`.env.speco.local` or `speco.local.json` at all, and a runtime directory
does not need to contain (or link to) either file to pass it. Any
failure is fail-closed: Speco does not start, and the specific reason is
printed (`NOT_FOUND`, `MISSING_FILE`, `NOT_GIT`, `STALE`, `DIRTY`), never
a silent fallback.

**Why ancestry, not an exact commit or a version string or a function
grep:** `main` keeps advancing past the fix commit, and every one of
those later commits is still safe to run. An exact-SHA check would need
manual updates forever and reject perfectly good newer code. A `VERSION`
literal or a `grep` for a function name is easy to defeat by accident (a
harmless rename breaks the grep; a copy-pasted string satisfies it
without the real fix). `merge-base --is-ancestor` answers the actual
question — "does this checkout descend from the commit that fixed the
bug?" — and keeps answering it correctly for every future commit that
descends from that fix, with no maintenance required until a *new*,
unrelated minimum commit needs to be established (a deliberate, rare
edit to `SPECO_MIN_FIX_COMMIT` in `scripts/lab/lib.sh`).

## Dirty-runtime guard

If `git -C "$SPECO_RUNTIME_DIR" status --porcelain` is non-empty, Speco
refuses to start. A runtime directory is meant to run reviewed, merged
code — never a local edit someone forgot they had open. Since config no
longer needs to live inside (or be symlinked into) the runtime directory,
there is nothing gitignored expected to sit there either; if `status.sh`/
`start.sh` reports `DIRTY`, it means the runtime checkout genuinely has
local changes.

## Config guard

Independently of the runtime check, `lab:start` checks that the resolved
**config** directory:

1. exists;
2. contains `.env.speco.local`;
3. contains `speco.local.json`.

Both files are required — a config directory with only one of the two
fails closed (`MISSING_ENV` or `MISSING_MAP`) rather than letting Speco
start and fail later, deep inside the Python process, once it actually
tries to read the missing file. An absent directory reports
`CONFIG_NOT_FOUND`. All three failure modes are fail-closed, same as the
runtime guard. Neither file's *contents* are ever read or printed by this
check — only their presence is verified.

## `PSOP_SPECO_RUNTIME_DIR` vs. `PSOP_SPECO_CONFIG_DIR`

These are deliberately separate, independently-resolved, independently-
validated concepts:

- **`PSOP_SPECO_RUNTIME_DIR`** — where `speco_n8nrl.py` (the executable
  code) lives: what the minimum-commit guard evaluates and what the
  spawned process's cwd is set to. No safe default — fail-closed if
  unresolved (see Fail-closed above).
- **`PSOP_SPECO_CONFIG_DIR`** — where both the lab manager (to look up
  the Keychain account name) and `speco_n8nrl.py` itself read
  `.env.speco.local` / `speco.local.json` from. Defaults to
  `$REPO_ROOT/apps/gateway` if unresolved, but its *contents* are still
  validated (see Config guard above).

`lab:start` resolves both, validates each independently, and — only if
both pass — exports `PSOP_SPECO_CONFIG_DIR` (along with the Keychain
password, `PSOP_SPECO_PASSWORD`) into the spawned process's environment.
`speco_n8nrl.py` reads that environment variable itself
(`resolve_speco_config_dir()`) to decide where its own config lives —
there is no symlink, no shared filesystem trick, and no dependency on the
runtime and config directories being related in any way. Running it
standalone, by hand, without `PSOP_SPECO_CONFIG_DIR` set, is unaffected:
it still reads config from next to the script, exactly as before this
design existed.

## `lab:status`

For Speco specifically, status re-derives ground truth from the live
process rather than trusting recorded metadata, and shows runtime and
config as two distinct blocks:

```
Speco          RUNNING
  pid 70582 — speco_n8nrl.py --watch
  runtime  <runtime-dir>/apps/gateway
  git HEAD abc1234...
  min fix  2ff1239 OK
  config   <config-dir>/apps/gateway
  config   OK
```

- `runtime` is read from the **live process's actual cwd** (`lsof -a -p
  PID -d cwd`), not just the metadata recorded at start time.
- If the live cwd disagrees with what was recorded when `lab:start`
  launched it (e.g. someone restarted it by hand outside the lab
  manager), a `WARNING` line is shown.
- `git HEAD` and `min fix` are recomputed live from that directory, every
  time `lab:status` runs — so a runtime directory that becomes stale or
  dirty *after* the watcher was started is still reported accurately,
  not masked by stale metadata. If the minimum-commit guard would now
  fail, status prints `INVALID RUNTIME` with the reason.
- `config` shows the resolved config directory's path and a fresh
  `speco_config_check` result — `INVALID CONFIG` with the reason if it
  would now fail. Never file contents, never the ingestion key, never the
  password.
- Status only reports any of this — it never kills or restarts anything
  automatically.

## `lab:stop`

Unchanged. Stopping Speco has never depended on the runtime or config
directories: it only needs the recorded PID, confirms the live process's
command line still matches the expected marker (protection against a
recycled PID), and signals the process group — `SIGTERM` first, `SIGKILL`
only if it doesn't exit in time. Never `killall`/`pkill`. This means
`lab:stop` keeps working even if the runtime directory has since been
deleted or moved.

## Dedicated runtime worktree

For the physical lab's steady state — as opposed to actively testing a
gateway change — the recommended setup is a dedicated worktree that
tracks `origin/main` in a **detached HEAD**, never a branch:

```sh
git fetch origin
git worktree add --detach \
  <path-to>/psop-runtime \
  origin/main
```

Detached HEAD is deliberate: it makes it awkward to accidentally commit
there (git actively warns about it), which is exactly the property we
want — this worktree exists to run code, not to receive it. A branch
would look "normal" enough that, over time, someone might `git add &&
git commit` there out of habit, reintroducing the same kind of drift this
whole design exists to prevent.

Then configure the lab manager to use it — for the current shell:

```sh
export PSOP_SPECO_RUNTIME_DIR=<path-to>/psop-runtime/apps/gateway
export PSOP_SPECO_CONFIG_DIR=<path-to>/psop/apps/gateway
```

or persistently, in `.psop-lab/runtime.env`:

```
PSOP_SPECO_RUNTIME_DIR=<path-to>/psop-runtime/apps/gateway
PSOP_SPECO_CONFIG_DIR=<path-to>/psop/apps/gateway
```

No symlink setup is needed — the runtime worktree can be pure, code-only
`main`, and the config directory keeps pointing at wherever
`.env.speco.local` / `speco.local.json` already live (typically the
development workspace).

**Updating the runtime worktree** is always a deliberate, manual act —
never automatic, so a human always decides when the physical hardware
starts running newer code:

```sh
git -C <path-to>/psop-runtime fetch origin
git -C <path-to>/psop-runtime checkout --detach origin/main
```

Only do this when the runtime worktree has no local changes (it
shouldn't have any, by design — the dirty-runtime guard will refuse to
start Speco if it does). After updating, `lab:status` will show the new
`git HEAD`; a full stop/start cycle of Speco is needed to actually pick
up the new code in a running process (updating the checked-out files on
disk does not affect an already-running Python process).

This worktree is **not created by this change** — this document
describes how to set it up when you're ready to.

## Secrets

Nothing here changes secret handling. The Speco NVR password still lives
only in the macOS Keychain (`security add-generic-password -a
"<account>" -s "psop-speco-nvr" -w`), is read once per `lab:start` into a
process-local environment variable, passed to the spawned watcher that
way (never on a command line, so it never appears in `ps`), and is
`unset` from the lab manager's own shell immediately after spawning.
`PSOP_SPECO_CONFIG_DIR` travels to the child the same way (export, then
unset in the parent) for interface consistency, even though it is not
itself a secret — it only ever names a directory, never a value from
inside it. `.env.speco.local` and `speco.local.json` remain git-ignored,
local-only files, read only by their own path — never committed, never
printed by `lab:status` or any of the runtime/config checks in this
document (they only report *paths*, never file contents).
