#!/usr/bin/env bash
#
# pnpm lab:stop - stop ONLY the services this lab started.
#
# Stops: API, Dashboard, Lorex gateway, Speco watcher.
# Never touches: psop-postgres, biaotech-postgres, Docker Desktop, or any
# other process. No killall / pkill / broad matching.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# stop_service NAME LABEL
# Only signals a PID that is (a) recorded in our pid file, (b) still alive, and
# (c) whose live command line still contains the service marker — so a recycled
# PID belonging to an unrelated program is never signalled.
stop_service() {
  local name="$1" label="$2"
  local pf; pf="$(pidfile "$name")"
  local pid

  if ! pid="$(read_pid "$name")"; then
    row "$label" "$(st_stopped)"; printf '%s\n' "${c_dim}    no pid file — nothing to do${c_reset}"
    return
  fi

  if ! pid_alive "$pid"; then
    row "$label" "$(st_stopped)"; printf '%s\n' "${c_dim}    pid ${pid} already gone${c_reset}"
    rm -f "$pf"
    return
  fi

  if ! pid_is_ours "$pid" "$name"; then
    row "$label" "$(st_warn "SKIPPED")"
    printf '%s\n' "${c_yellow}    pid ${pid} is alive but does not look like PSOP ${name}:${c_reset}"
    printf '%s\n' "${c_dim}      $(pid_cmd "$pid")${c_reset}"
    printf '%s\n' "${c_dim}    leaving it untouched; removing stale pid file${c_reset}"
    rm -f "$pf"
    return
  fi

  # Signal the whole process group (negative pid); spawn.py made this pid a
  # session leader, so the group contains only this service's tree.
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    pid_alive "$pid" || break
    nap 0.5
  done
  if pid_alive "$pid"; then
    kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    nap 1
  fi

  if pid_alive "$pid"; then
    row "$label" "$(st_warn "STILL UP")"; printf '%s\n' "${c_red}    pid ${pid} would not stop${c_reset}"
  else
    row "$label" "$(st_stopped)"
    rm -f "$pf"
  fi
}

echo "PSOP LAB STOP"
echo "--------------------------------"

stop_service api       "API"
stop_service dashboard "Dashboard"
stop_service speco     "Speco"
stop_service lorex     "Lorex"

# Postgres is intentionally left running.
if pg_online; then
  row "PostgreSQL" "$(st_online)"
  printf '%s\n' "${c_dim}    left running on purpose (shared infrastructure)${c_reset}"
else
  row "PostgreSQL" "$(st_offline)"
fi

echo
# Report, without touching, any unmanaged gateway processes still around.
for pat in 'speco_n8nrl.py' 'psop_gateway.py'; do
  hits="$(pgrep -f -U "$(id -u)" "$pat" 2>/dev/null || true)"
  [ -n "$hits" ] && warn "Note: ${pat} still running (pid(s): ${hits//$'\n'/ }) — not started by this lab, not stopped."
done
exit 0
