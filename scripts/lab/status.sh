#!/usr/bin/env bash
#
# pnpm lab:status - read-only view of the PSOP local lab. Changes nothing.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

detail() { printf '%s%s%s\n' "$c_dim" "    $*" "$c_reset"; }

echo "PSOP LAB STATUS"
echo "--------------------------------"

# --- PostgreSQL --------------------------------------------------------
case "$(pg_state)" in
  "running healthy") row "PostgreSQL" "$(st_online)";  detail "container ${PG_CONTAINER} — healthy" ;;
  "running none")    row "PostgreSQL" "$(st_online)";  detail "container ${PG_CONTAINER} — running" ;;
  "running "*)       s="$(pg_state)"; row "PostgreSQL" "$(st_warn "STARTING")"; detail "container ${PG_CONTAINER} — ${s#running }" ;;
  stopped)           row "PostgreSQL" "$(st_offline)"; detail "container ${PG_CONTAINER} exists but is stopped" ;;
  absent)            row "PostgreSQL" "$(st_offline)"; detail "container ${PG_CONTAINER} not found" ;;
esac

# --- API -------------------------------------------------------------
if api_healthy; then
  row "API" "$(st_online)"
  if pid="$(read_pid api)" && pid_alive "$pid"; then detail "pid ${pid}, port ${API_PORT}, /health OK"
  else detail "port ${API_PORT}, /health OK (not managed by this lab)"; fi
elif pid="$(read_pid api)" && pid_alive "$pid" && pid_is_ours "$pid" api; then
  row "API" "$(st_warn "UNHEALTHY")"; detail "pid ${pid} alive but ${HEALTH_URL} not OK"
else
  row "API" "$(st_offline)"
  [ -n "$(port_pids "$API_PORT")" ] && detail "port ${API_PORT} held by pid(s): $(port_pids "$API_PORT" | tr '\n' ' ')"
fi

# --- Dashboard -----------------------------------------------------
if service_running dashboard; then
  row "Dashboard" "$(st_online)"; detail "pid $(read_pid dashboard), port ${DASH_PORT}$(dash_responding && printf ', HTTP OK')"
elif dash_responding; then
  row "Dashboard" "$(st_online)"; detail "port ${DASH_PORT}, HTTP OK (not managed by this lab)"
elif pid="$(read_pid dashboard)" && pid_alive "$pid"; then
  row "Dashboard" "$(st_warn "UNHEALTHY")"; detail "pid ${pid} alive but not responding on ${DASH_PORT}"
else
  row "Dashboard" "$(st_offline)"
fi

# --- Speco watcher -----------------------------------------------
if service_running speco; then
  row "Speco" "$(st_running)"; detail "pid $(read_pid speco) — speco_n8nrl.py --watch"
elif ext="$(pgrep -f -U "$(id -u)" 'speco_n8nrl.py' 2>/dev/null)" && [ -n "$ext" ]; then
  row "Speco" "$(st_running)"; detail "pid(s) ${ext//$'\n'/ } (not managed by this lab)"
elif pid="$(read_pid speco)" && [ -f "$(pidfile speco)" ]; then
  row "Speco" "$(st_offline)"; detail "tracked pid ${pid} is gone"
else
  row "Speco" "$(st_offline)"
fi

# --- Lorex gateway ---------------------------------------------
if service_running lorex; then
  row "Lorex" "$(st_running)"; detail "pid $(read_pid lorex) — psop_gateway.py"
elif ext="$(pgrep -f -U "$(id -u)" 'psop_gateway.py' 2>/dev/null)" && [ -n "$ext" ]; then
  row "Lorex" "$(st_running)"; detail "pid(s) ${ext//$'\n'/ } (not managed by this lab)"
elif pid="$(read_pid lorex)" && [ -f "$(pidfile lorex)" ]; then
  row "Lorex" "$(st_offline)"; detail "tracked pid ${pid} is gone"
else
  row "Lorex" "$(st_offline)"
fi

echo
echo "Logs: ${LOG_DIR}"
