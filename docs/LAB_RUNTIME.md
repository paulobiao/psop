# PSOP Local Lab Manager — Speco Runtime Selection

The local lab manager (`pnpm lab:start` / `lab:status` / `lab:stop`,
implemented in `scripts/lab/`) brings up PostgreSQL, the API, the
Dashboard, the Lorex gateway, and the Speco NVR watcher for local
development and for the physical lab (a real Speco N8NRL NVR and its
Hikvision child cameras).

This document explains why the Speco watcher — and only the Speco
watcher — has an explicit, fail-closed runtime selection instead of just
running whatever code happens to be on disk.

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

## Setup

1. Pick (or create) a directory containing a working checkout of
   `apps/gateway/` — this can be the development workspace itself while
   you're actively testing a gateway change, or (recommended for the
   physical lab's steady state) a dedicated, clean worktree tracking
   `main` — see "Dedicated runtime worktree" below.
2. Make sure `.env.speco.local` is reachable *next to* `speco_n8nrl.py` in
   that directory — `speco_n8nrl.py` resolves its own config relative to
   its own file location (`Path(__file__).resolve().parent`), not the
   process's cwd, so this file has to physically be there (a symlink to
   the real config file is the normal way to do this without duplicating
   secrets):

   ```sh
   ln -s /path/to/config-source/apps/gateway/.env.speco.local \
         /path/to/runtime/apps/gateway/.env.speco.local
   ln -s /path/to/config-source/apps/gateway/speco.local.json \
         /path/to/runtime/apps/gateway/speco.local.json
   ```

3. Point the lab manager at it — see "Precedence" below.
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
PSOP_SPECO_RUNTIME_DIR=/path/to/runtime/apps/gateway
PSOP_SPECO_CONFIG_DIR=/path/to/config-source/apps/gateway
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

## Fail-closed (runtime directory only)

If neither (1) nor (2) resolves a runtime directory, `lab:start` **does
not** fall back to `$REPO_ROOT/apps/gateway`. It refuses to start the
Speco watcher, prints exactly why, and continues bringing up the other
services (a missing/invalid Speco runtime is reported, not fatal to the
rest of the lab — consistent with how a missing Keychain password is
already handled today).

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

This is deliberate: this lab has already had a stale-runtime incident
against real hardware. A one-time configuration step is a small price for
never again silently running unknown code against a physical NVR.

The **config** directory (`PSOP_SPECO_CONFIG_DIR`) does **not** fail
closed — it defaults to `$REPO_ROOT/apps/gateway` (the development
workspace's existing local config) if unset. Config is local, git-ignored
*data* (a username, a device key, a mapping file), not executable code;
defaulting it does not reintroduce the risk that runtime-directory
selection guards against, and requiring it to be configured for every
workspace would just be friction with no safety benefit.

## Minimum-commit guard

Before starting Speco, `lab:start` checks that the resolved runtime
directory:

1. exists;
2. contains `speco_n8nrl.py`;
3. has a reachable `.env.speco.local` next to it (real file or symlink —
   see Setup);
4. is inside a valid git worktree;
5. has the minimum required fix commit as an **ancestor** of its `HEAD`:

   ```sh
   git -C "$SPECO_RUNTIME_DIR" merge-base --is-ancestor \
     2ff1239292461bba2bde2c5af7a248cbda275d05 \
     HEAD
   ```

6. is **not dirty** (`git status --porcelain` is empty — see below).

Any failure is fail-closed: Speco does not start, and the specific reason
is printed (`NOT_FOUND`, `MISSING_FILE`, `MISSING_CONFIG`, `NOT_GIT`,
`STALE`, `DIRTY`), never a silent fallback.

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
code — never a local edit someone forgot they had open. Config symlinks
(`.env.speco.local`, `speco.local.json`) are already listed in
`.gitignore`, so a properly set-up runtime directory shows clean even
with them present; if `status.sh`/`start.sh` reports `DIRTY` unexpectedly,
check for real, non-ignored local changes first.

## `PSOP_SPECO_RUNTIME_DIR` vs. `PSOP_SPECO_CONFIG_DIR`

These are deliberately separate concepts:

- **`PSOP_SPECO_RUNTIME_DIR`** — where `speco_n8nrl.py` (the executable
  code) lives, and therefore what the minimum-commit guard evaluates and
  what the process's cwd is set to.
- **`PSOP_SPECO_CONFIG_DIR`** — where the lab manager itself reads
  `.env.speco.local` from, to look up the Keychain account name before
  fetching the password. Defaults to `$REPO_ROOT/apps/gateway`.

In practice, for `speco_n8nrl.py` itself to find its own config, the
runtime directory still needs a reachable `.env.speco.local` next to it
(see Setup — normally a symlink into the config directory). The two
variables exist so the *lab manager's own* config lookup and the
*executable code's* location are never silently conflated in the lab
manager's logic — but the running process's own config resolution is
governed by where the file physically is, not by these variables.

## `lab:status`

For Speco specifically, status re-derives ground truth from the live
process rather than trusting recorded metadata:

```
Speco          RUNNING
  pid 70582 — speco_n8nrl.py --watch
  runtime  /Users/.../psop-runtime/apps/gateway
  git HEAD abc1234...
  min fix  2ff1239 OK
```

- `runtime` is read from the **live process's actual cwd** (`lsof -a -p
  PID -d cwd`), not just the metadata recorded at start time.
- If the live cwd disagrees with what was recorded when `lab:start`
  launched it (e.g. someone restarted it by hand outside the lab
  manager), a `WARNING` line is shown.
- `git HEAD` and `min fix` are recomputed live from that directory, every
  time `lab:status` runs — so a runtime directory that becomes stale or
  dirty *after* the watcher was started is still reported accurately,
  not masked by stale metadata.
- If the minimum-commit guard would now fail for the currently-running
  process's directory, status prints `INVALID RUNTIME` with the reason.
  It only reports this — it never kills or restarts anything
  automatically.

## `lab:stop`

Unchanged. Stopping Speco has never depended on the runtime directory:
it only needs the recorded PID, confirms the live process's command line
still matches the expected marker (protection against a recycled PID),
and signals the process group — `SIGTERM` first, `SIGKILL` only if it
doesn't exit in time. Never `killall`/`pkill`. This means `lab:stop`
keeps working even if the runtime directory has since been deleted or
moved.

## Dedicated runtime worktree

For the physical lab's steady state — as opposed to actively testing a
gateway change — the recommended setup is a dedicated worktree that
tracks `origin/main` in a **detached HEAD**, never a branch:

```sh
git fetch origin
git worktree add --detach \
  ~/02_PROJETOS/BiaoTech-Master/psop-runtime \
  origin/main
```

Detached HEAD is deliberate: it makes it awkward to accidentally commit
there (git actively warns about it), which is exactly the property we
want — this worktree exists to run code, not to receive it. A branch
would look "normal" enough that, over time, someone might `git add &&
git commit` there out of habit, reintroducing the same kind of drift this
whole design exists to prevent.

Then configure the lab manager to use it — either for the current shell:

```sh
export PSOP_SPECO_RUNTIME_DIR=~/02_PROJETOS/BiaoTech-Master/psop-runtime/apps/gateway
```

or persistently, in `.psop-lab/runtime.env`:

```
PSOP_SPECO_RUNTIME_DIR=/Users/<you>/02_PROJETOS/BiaoTech-Master/psop-runtime/apps/gateway
```

Remember to symlink the config files into it (see Setup).

**Updating the runtime worktree** is always a deliberate, manual act —
never automatic, so a human always decides when the physical hardware
starts running newer code:

```sh
git -C ~/02_PROJETOS/BiaoTech-Master/psop-runtime fetch origin
git -C ~/02_PROJETOS/BiaoTech-Master/psop-runtime checkout --detach origin/main
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
`.env.speco.local` and `speco.local.json` remain git-ignored, local-only
files (or symlinks to them) — never committed, never printed by
`lab:status` or the runtime checks in this document (they only report
*paths*, never file contents).
