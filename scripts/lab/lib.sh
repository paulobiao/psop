# shellcheck shell=bash
#
# Shared helpers for the PSOP local lab manager (lab:start / lab:status / lab:stop).
#
# Design notes:
#   * Nothing here starts automatically. Every service is launched only when the
#     user runs `pnpm lab:start`.
#   * Each managed service is spawned in its own session (see spawn.py) so we can
#     stop the whole process tree without touching unrelated processes and
#     without ever using broad commands like killall/pkill.
#   * Runtime state (PID files + logs) lives under .psop-lab/, which is
#     git-ignored and kept separate from application files.
#   * Secrets (the Speco NVR password) are only ever held in process memory /
#     environment, never written to disk or logs.

set -euo pipefail

# --- Paths -------------------------------------------------------------------

LAB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LAB_LIB_DIR/../.." && pwd)"
LAB_DIR="$REPO_ROOT/.psop-lab"
PID_DIR="$LAB_DIR/pids"
LOG_DIR="$LAB_DIR/logs"
SPAWN="$LAB_LIB_DIR/spawn.py"

mkdir -p "$PID_DIR" "$LOG_DIR"

# --- Configuration ---------------------------------------------------------

API_PORT=3100
DASH_PORT=5173
HEALTH_URL="http://127.0.0.1:${API_PORT}/api/v1/health"
DASH_URL="http://127.0.0.1:${DASH_PORT}"
PG_CONTAINER="psop-postgres"
COMPOSE_FILE="$REPO_ROOT/infra/docker/compose.yml"

# macOS Keychain coordinates for the Speco NVR reader password.
SPECO_KC_SERVICE="psop-speco-nvr"

# Per-service command marker. stop.sh only kills a PID whose live command line
# still contains the matching marker, so a recycled PID belonging to another
# program is never touched. (Plain function — macOS ships bash 3.2, no assoc
# arrays.)
service_marker() {
  # These match the command line of the tracked (session-leader) process:
  #   api/dashboard -> the `pnpm --filter <name> ...` wrapper
  #   lorex/speco   -> the python script invoked directly
  case "$1" in
    api)       printf -- '--filter api' ;;
    dashboard) printf -- '--filter dashboard' ;;
    lorex)     printf 'psop_gateway.py' ;;
    speco)     printf 'speco_n8nrl.py' ;;
    *)         printf '__no_such_service__' ;;
  esac
}

# --- Small utilities -------------------------------------------------------

if [ -t 1 ] && [ -t 2 ] && [ "${NO_COLOR:-}" = "" ]; then
  c_reset=$'\033[0m'; c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'; c_dim=$'\033[2m'
else
  c_reset=''; c_green=''; c_red=''; c_yellow=''; c_dim=''
fi

log()  { printf '%s\n' "$*" >&2; }
ok()   { printf '%s%s%s\n' "$c_green" "$*" "$c_reset" >&2; }
warn() { printf '%s%s%s\n' "$c_yellow" "$*" "$c_reset" >&2; }
err()  { printf '%s%s%s\n' "$c_red" "$*" "$c_reset" >&2; }

# nap SECONDS - a plain sleep wrapper, isolated so intent is obvious.
nap() { sleep "$1"; }

pidfile()  { printf '%s/%s.pid' "$PID_DIR" "$1"; }
logfile()  { printf '%s/%s.log' "$LOG_DIR" "$1"; }

read_pid() {
  local f; f="$(pidfile "$1")"
  [ -f "$f" ] || return 1
  local p; p="$(tr -dc '0-9' < "$f")"
  [ -n "$p" ] || return 1
  printf '%s' "$p"
}

pid_alive() { kill -0 "$1" 2>/dev/null; }

# pid_cmd PID - live command line for a pid (empty if gone).
pid_cmd() { ps -p "$1" -o command= 2>/dev/null || true; }

# pid_is_ours PID SERVICE - true if the live command matches the service marker.
pid_is_ours() {
  local cmd marker
  cmd="$(pid_cmd "$1")"
  marker="$(service_marker "$2")"
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *"$marker"*) return 0 ;;
    *) return 1 ;;
  esac
}

# port_pids PORT - PIDs listening on a TCP port (current user only).
port_pids() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }

# service_running SERVICE - true if the tracked PID is alive AND still ours.
service_running() {
  local pid
  pid="$(read_pid "$1")" || return 1
  pid_alive "$pid" || return 1
  pid_is_ours "$pid" "$1"
}

# spawn SERVICE -- CMD...   (extra env is inherited from the caller)
# Launches CMD in a new session, appending stdout+stderr to the service log,
# and records the session-leader PID.
spawn() {
  local name="$1"; shift
  local lf; lf="$(logfile "$name")"
  {
    printf '\n===== %s : starting %s =====\n' "$name" "$(date '+%Y-%m-%d %H:%M:%S')"
  } >> "$lf"
  python3 "$SPAWN" "$lf" "$@" &
  local pid=$!
  printf '%s\n' "$pid" > "$(pidfile "$name")"
  printf '%s' "$pid"
}

# --- HTTP / health -------------------------------------------------------

api_healthy() {
  curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q '"service":"psop-api"'
}

dash_responding() {
  curl -fsS --max-time 3 -o /dev/null "$DASH_URL" 2>/dev/null
}

# --- Postgres (Docker) --------------------------------------------------

pg_state() {
  # Prints: "running healthy" | "running <status>" | "stopped" | "absent"
  local out
  if ! out="$(docker inspect -f '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$PG_CONTAINER" 2>/dev/null)"; then
    printf 'absent'; return
  fi
  local running="${out%%|*}" health="${out##*|}"
  if [ "$running" = "true" ]; then
    printf 'running %s' "$health"
  else
    printf 'stopped'
  fi
}

pg_online() {
  case "$(pg_state)" in
    "running healthy"|"running none") return 0 ;;
    *) return 1 ;;
  esac
}

# --- Speco password (macOS Keychain) ----------------------------------
#
# These read from an explicit config directory (see "Speco runtime
# selection" below) rather than a hardcoded $REPO_ROOT path, so the lab
# manager's own config lookup follows the same explicit-directory
# discipline as the runtime code it spawns.

speco_env_get() {
  local key="$1" dir="$2" f
  f="$dir/.env.speco.local"
  [ -f "$f" ] || return 1
  grep -E "^${key}=" "$f" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'
}

speco_kc_account() {
  local dir="$1" a
  a="$(speco_env_get PSOP_SPECO_USERNAME "$dir" || true)"
  printf '%s' "${a:-psop_reader}"
}

# Prints the password on stdout, or nothing (and returns 1) if not in Keychain.
speco_password_from_keychain() {
  local dir="$1" acct
  acct="$(speco_kc_account "$dir")"
  security find-generic-password -s "$SPECO_KC_SERVICE" -a "$acct" -w 2>/dev/null
}

speco_keychain_hint() {
  local dir="$1" acct
  acct="$(speco_kc_account "$dir")"
  cat >&2 <<EOF

${c_yellow}Speco NVR password is not in the macOS Keychain yet.${c_reset}
Register it ONCE with the command below. It prompts interactively; the password
is not echoed, not stored in shell history, and never written into the repo:

    ${c_green}security add-generic-password -a "${acct}" -s "${SPECO_KC_SERVICE}" -w${c_reset}

Then run '${c_green}pnpm lab:start${c_reset}' again and the Speco watcher will start automatically.
EOF
}

# --- Speco runtime selection (explicit, fail-closed) ---------------------
#
# The Speco watcher executes real code against real hardware (an NVR and
# its child cameras). Unlike the other lab services, it must never fall
# back silently to "whatever commit happens to be checked out in the
# worktree these scripts live in" — that exact failure mode produced a
# multi-hour incident where a stale pre-fix watcher kept renewing a fake
# ONLINE heartbeat while the NVR was physically unreachable. See
# docs/LAB_RUNTIME.md for the full incident and the design this codifies.

# The commit that introduced recorderReachable/watch_tick/RELOGIN_ semantics
# ("fix: stop stale Speco heartbeats when recorder is unreachable"). Any
# runtime directory must have this commit as an ancestor of its HEAD.
# Overridable (e.g. by tests); not meant to be changed for normal use.
SPECO_MIN_FIX_COMMIT="${SPECO_MIN_FIX_COMMIT:-2ff1239292461bba2bde2c5af7a248cbda275d05}"

_lab_runtime_env_file() { printf '%s/runtime.env' "$LAB_DIR"; }

# lab_runtime_env_get KEY - safe, non-eval reader for .psop-lab/runtime.env.
# Only a fixed whitelist of keys is accepted, plain "KEY=value" lines are
# parsed by hand, and the file is never sourced/eval'd.
lab_runtime_env_get() {
  local key="$1" f line value
  case "$key" in
    PSOP_SPECO_RUNTIME_DIR|PSOP_SPECO_CONFIG_DIR) ;;
    *) return 1 ;;
  esac
  f="$(_lab_runtime_env_file)"
  [ -f "$f" ] || return 1
  line="$(grep -E "^${key}=" "$f" 2>/dev/null | tail -1)" || true
  [ -n "$line" ] || return 1
  value="${line#*=}"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

# speco_runtime_dir_resolve - PSOP_SPECO_RUNTIME_DIR env var, else
# .psop-lab/runtime.env, else EMPTY. Deliberately no fallback to
# $REPO_ROOT/apps/gateway — see the module comment above.
speco_runtime_dir_resolve() {
  if [ -n "${PSOP_SPECO_RUNTIME_DIR:-}" ]; then
    printf '%s' "$PSOP_SPECO_RUNTIME_DIR"
    return 0
  fi
  lab_runtime_env_get PSOP_SPECO_RUNTIME_DIR
}

# speco_runtime_dir_source - which of the two sources above resolved the
# runtime dir (or "none"), for diagnostic messages.
speco_runtime_dir_source() {
  if [ -n "${PSOP_SPECO_RUNTIME_DIR:-}" ]; then
    printf 'environment variable PSOP_SPECO_RUNTIME_DIR'
  elif lab_runtime_env_get PSOP_SPECO_RUNTIME_DIR >/dev/null 2>&1; then
    printf '%s' "$(_lab_runtime_env_file)"
  else
    printf 'none'
  fi
}

# speco_config_dir_resolve - where the lab manager itself reads
# .env.speco.local from (to look up the Keychain account name). Unlike the
# runtime dir, this HAS a safe default: PSOP_SPECO_CONFIG_DIR env var, else
# .psop-lab/runtime.env, else $REPO_ROOT/apps/gateway (this worktree's
# existing local config — unchanged from before runtime selection existed).
# Config is local, gitignored data, not executable code, so defaulting it
# does not reintroduce the stale-code risk that runtime dir selection
# guards against.
speco_config_dir_resolve() {
  if [ -n "${PSOP_SPECO_CONFIG_DIR:-}" ]; then
    printf '%s' "$PSOP_SPECO_CONFIG_DIR"
    return 0
  fi
  local v
  if v="$(lab_runtime_env_get PSOP_SPECO_CONFIG_DIR)"; then
    printf '%s' "$v"
    return 0
  fi
  printf '%s/apps/gateway' "$REPO_ROOT"
}

speco_runtime_head() {
  git -C "$1" rev-parse HEAD 2>/dev/null
}

# speco_runtime_check DIR [MIN_COMMIT] - the single source of truth used by
# both lab:start (enforced, fail-closed) and lab:status (displayed,
# non-fatal) for the RUNTIME (executable code) directory only. Prints
# exactly one status token to stdout; returns 0 only for OK. Deliberately
# does NOT look at .env.speco.local/speco.local.json — that is a separate
# concern, checked independently by speco_config_check() below, so a
# runtime directory never needs to physically contain (or symlink) local
# config just to pass validation. speco_n8nrl.py itself still needs a
# reachable config via PSOP_SPECO_CONFIG_DIR at spawn time (see start.sh) —
# that is what makes the two independent instead of implicitly coupled.
speco_runtime_check() {
  local dir="$1" min="${2:-$SPECO_MIN_FIX_COMMIT}"

  if [ -z "$dir" ]; then
    printf 'NOT_CONFIGURED'; return 1
  fi
  if [ ! -d "$dir" ]; then
    printf 'NOT_FOUND'; return 1
  fi
  if [ ! -f "$dir/speco_n8nrl.py" ]; then
    printf 'MISSING_FILE'; return 1
  fi
  if ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'NOT_GIT'; return 1
  fi
  if ! git -C "$dir" merge-base --is-ancestor "$min" HEAD 2>/dev/null; then
    printf 'STALE'; return 1
  fi
  if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
    printf 'DIRTY'; return 1
  fi
  printf 'OK'; return 0
}

# speco_runtime_check_message TOKEN DIR [MIN_COMMIT] - human-readable detail
# for a status token returned by speco_runtime_check.
speco_runtime_check_message() {
  local token="$1" dir="$2" min="${3:-$SPECO_MIN_FIX_COMMIT}"
  case "$token" in
    NOT_CONFIGURED)
      printf 'Speco runtime is not configured (set PSOP_SPECO_RUNTIME_DIR, or add it to %s)' \
        "$(_lab_runtime_env_file)" ;;
    NOT_FOUND)      printf 'runtime directory does not exist: %s' "$dir" ;;
    MISSING_FILE)   printf 'speco_n8nrl.py not found in: %s' "$dir" ;;
    NOT_GIT)        printf 'runtime directory is not inside a git worktree: %s' "$dir" ;;
    STALE)          printf 'runtime HEAD does not have %s (minimum required fix) as an ancestor' "$min" ;;
    DIRTY)          printf 'runtime has local uncommitted changes (git status is not clean): %s' "$dir" ;;
    OK)             printf 'runtime OK' ;;
    *)              printf 'unknown runtime status: %s' "$token" ;;
  esac
}

# speco_config_check DIR - validates the CONFIG directory independently of
# the runtime directory: it must exist and contain both
# .env.speco.local AND speco.local.json (the mapping file is just as
# required as the env file — a config dir with only one of the two would
# otherwise pass validation here and only fail later, deep inside the
# Python process, after the watcher already thinks it started). Never
# reads or prints file contents. Prints exactly one status token; returns
# 0 only for CONFIG_OK.
speco_config_check() {
  local dir="$1"

  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    printf 'CONFIG_NOT_FOUND'; return 1
  fi
  if [ ! -e "$dir/.env.speco.local" ]; then
    printf 'MISSING_ENV'; return 1
  fi
  if [ ! -e "$dir/speco.local.json" ]; then
    printf 'MISSING_MAP'; return 1
  fi
  printf 'CONFIG_OK'; return 0
}

# speco_config_check_message TOKEN DIR - human-readable detail for a status
# token returned by speco_config_check. Paths only, never file contents.
speco_config_check_message() {
  local token="$1" dir="$2"
  case "$token" in
    CONFIG_NOT_FOUND) printf 'config directory does not exist: %s' "$dir" ;;
    MISSING_ENV)      printf '.env.speco.local not found in: %s' "$dir" ;;
    MISSING_MAP)      printf 'speco.local.json not found in: %s' "$dir" ;;
    CONFIG_OK)        printf 'config OK' ;;
    *)                printf 'unknown config status: %s' "$token" ;;
  esac
}

# speco_cwd_matches ACTUAL EXPECTED - normalized comparison used by
# lab:status to warn when a live process's real cwd disagrees with the
# runtime directory recorded in metadata (e.g. someone started it by hand).
speco_cwd_matches() {
  local actual="${1%/}" expected="${2%/}"
  [ "$actual" = "$expected" ]
}

# pid_cwd PID - the real, live working directory of a process (empty if it
# cannot be determined). Used by lab:status to show ground truth rather
# than trusting recorded metadata alone.
pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
}

# --- Speco runtime metadata (.psop-lab/speco.runtime) ---------------------
#
# A non-sensitive breadcrumb written on a successful start, read by
# lab:status. Deliberately NOT trusted blindly: status always re-checks the
# live process and its real cwd too (see pid_cwd / speco_cwd_matches above).

speco_runtime_metadata_file() { printf '%s/speco.runtime' "$LAB_DIR"; }

speco_runtime_metadata_write() {
  local dir="$1" head="$2" check="$3" config_dir="$4" config_check="$5" f
  f="$(speco_runtime_metadata_file)"
  {
    printf 'PSOP_SPECO_RUNTIME_DIR=%s\n' "$dir"
    printf 'GIT_HEAD=%s\n' "$head"
    printf 'MIN_COMMIT_CHECK=%s\n' "$check"
    printf 'PSOP_SPECO_CONFIG_DIR=%s\n' "$config_dir"
    printf 'CONFIG_CHECK=%s\n' "$config_check"
    printf 'STARTED_AT=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  } > "$f"
}

speco_runtime_metadata_get() {
  local key="$1" f line
  case "$key" in
    PSOP_SPECO_RUNTIME_DIR|GIT_HEAD|MIN_COMMIT_CHECK|PSOP_SPECO_CONFIG_DIR|CONFIG_CHECK|STARTED_AT) ;;
    *) return 1 ;;
  esac
  f="$(speco_runtime_metadata_file)"
  [ -f "$f" ] || return 1
  line="$(grep -E "^${key}=" "$f" 2>/dev/null | tail -1)" || return 1
  [ -n "$line" ] || return 1
  printf '%s' "${line#*=}"
}

# --- Status line rendering -------------------------------------------

row() { printf '  %-14s %s\n' "$1" "$2"; }
st_online()  { printf '%sONLINE%s'  "$c_green"  "$c_reset"; }
st_running() { printf '%sRUNNING%s' "$c_green"  "$c_reset"; }
st_offline() { printf '%sOFFLINE%s' "$c_red"    "$c_reset"; }
st_stopped() { printf '%sSTOPPED%s' "$c_dim"    "$c_reset"; }
st_warn()    { printf '%s%s%s'      "$c_yellow" "$1" "$c_reset"; }
