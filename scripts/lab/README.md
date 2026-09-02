# PSOP local lab manager

One manual command to bring up / inspect / tear down the full local PSOP
laboratory. Nothing here starts on its own — there is **no macOS autostart and no
daemon**. Services run only while you keep the lab up.

```
pnpm lab:start    # start Postgres check → API → Dashboard → Lorex → Speco
pnpm lab:status   # read-only health view (changes nothing)
pnpm lab:stop     # stop ONLY what the lab started (Postgres stays up)
```

## What it manages

| Service        | Command                                                        | Port |
|----------------|---------------------------------------------------------------|------|
| PostgreSQL     | Docker container `psop-postgres` (via `infra/docker/compose.yml`) | 5433 |
| API            | `LOCAL_TELEMETRY_INGESTION_ENABLED=true pnpm --filter api start:dev` | 3100 |
| Dashboard      | `pnpm --filter dashboard dev`                                  | 5173 |
| Lorex gateway  | `bash apps/gateway/run_gateway.sh --config apps/gateway/gateway.local.json` | — |
| Speco watcher  | `python3 apps/gateway/speco_n8nrl.py --watch --interval 30`    | — |

Health endpoint: `http://127.0.0.1:3100/api/v1/health`

## Runtime state

PID files and logs live under `.psop-lab/` (git-ignored, never mixed with app
files):

```
.psop-lab/pids/{api,dashboard,lorex,speco}.pid
.psop-lab/logs/{api,dashboard,lorex,speco}.log
```

## Speco NVR password (macOS Keychain)

The Speco watcher needs the `psop_reader` NVR password. It is **never** stored in
`.env`, JSON, scripts, or git. `lab:start` reads it from the macOS Keychain at
runtime and passes it to `speco_n8nrl.py` through the `PSOP_SPECO_PASSWORD`
environment variable only (never on a command line, so it does not show up in
`ps`).

Register it once (interactive prompt, not echoed, not in shell history):

```
security add-generic-password -a "psop_reader" -s "psop-speco-nvr" -w
```

Until that entry exists, `lab:start` starts everything else and prints this hint;
the Speco watcher is simply skipped.

## Safety guarantees

* Never uses `killall`, `pkill`, or broad pattern matching.
* `lab:stop` signals a PID only if it is in our pid file, still alive, **and**
  its live command line still matches the expected service — a recycled PID is
  left alone.
* Each service is started in its own session (`setsid`), so stop signals the
  service's process group only.
* `psop-postgres`, `biaotech-postgres`, Docker Desktop, and unrelated
  Node/Python processes are never stopped.
* A crash in one service does not tear down the others; `lab:status` will show it
  as `OFFLINE`.
