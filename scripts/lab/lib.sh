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

speco_env_get() {
  local f="$REPO_ROOT/apps/gateway/.env.speco.local"
  [ -f "$f" ] || return 1
  grep -E "^$1=" "$f" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'
}

speco_kc_account() {
  local a; a="$(speco_env_get PSOP_SPECO_USERNAME || true)"
  printf '%s' "${a:-psop_reader}"
}

# Prints the password on stdout, or nothing (and returns 1) if not in Keychain.
speco_password_from_keychain() {
  local acct; acct="$(speco_kc_account)"
  security find-generic-password -s "$SPECO_KC_SERVICE" -a "$acct" -w 2>/dev/null
}

speco_keychain_hint() {
  local acct; acct="$(speco_kc_account)"
  cat >&2 <<EOF

${c_yellow}Speco NVR password is not in the macOS Keychain yet.${c_reset}
Register it ONCE with the command below. It prompts interactively; the password
is not echoed, not stored in shell history, and never written into the repo:

    ${c_green}security add-generic-password -a "${acct}" -s "${SPECO_KC_SERVICE}" -w${c_reset}

Then run '${c_green}pnpm lab:start${c_reset}' again and the Speco watcher will start automatically.
EOF
}

# --- Status line rendering -------------------------------------------

row() { printf '  %-14s %s\n' "$1" "$2"; }
st_online()  { printf '%sONLINE%s'  "$c_green"  "$c_reset"; }
st_running() { printf '%sRUNNING%s' "$c_green"  "$c_reset"; }
st_offline() { printf '%sOFFLINE%s' "$c_red"    "$c_reset"; }
st_stopped() { printf '%sSTOPPED%s' "$c_dim"    "$c_reset"; }
st_warn()    { printf '%s%s%s'      "$c_yellow" "$1" "$c_reset"; }
