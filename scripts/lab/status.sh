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
#
# Speco gets a richer status block than the other services: it is the one
# service with an explicit runtime selection and a minimum-commit guard
# (docs/LAB_RUNTIME.md), so status shows exactly what code is live and
# whether it satisfies that guard — never trusting recorded metadata alone,
# always re-deriving from the live process (pid_cwd) and a fresh git check.
if service_running speco; then
  pid="$(read_pid speco)"
  row "Speco" "$(st_running)"; detail "pid ${pid} — speco_n8nrl.py --watch"

  real_cwd="$(pid_cwd "$pid")"
  meta_dir="$(speco_runtime_metadata_get PSOP_SPECO_RUNTIME_DIR || true)"

  # Ground truth for "what is actually running" is the live process cwd,
  # not the recorded metadata (which could predate a manual restart).
  effective_dir="${real_cwd:-$meta_dir}"

  if [ -n "$real_cwd" ]; then
    detail "runtime  ${real_cwd}"
  else
    detail "runtime  ${c_yellow}unknown (could not read live cwd)${c_reset}"
  fi

  if [ -n "$meta_dir" ] && [ -n "$real_cwd" ] && ! speco_cwd_matches "$real_cwd" "$meta_dir"; then
    detail "${c_yellow}WARNING: live cwd differs from the runtime recorded at start (${meta_dir}) — was this process started outside lab:start?${c_reset}"
  fi

  if [ -n "$effective_dir" ]; then
    head="$(speco_runtime_head "$effective_dir" || true)"
    check="$(speco_runtime_check "$effective_dir")"
    detail "git HEAD ${head:-unknown}"
    if [ "$check" = "OK" ]; then
      detail "min runtime ${SPECO_MIN_RUNTIME_COMMIT:0:7} OK"
    else
      detail "${c_red}INVALID RUNTIME: $(speco_runtime_check_message "$check" "$effective_dir")${c_reset}"
    fi
  fi

  # Config is a separate concern from runtime code (docs/LAB_RUNTIME.md):
  # shown as its own block, path only — .env.speco.local/speco.local.json
  # contents are never read or printed here.
  meta_config_dir="$(speco_runtime_metadata_get PSOP_SPECO_CONFIG_DIR || true)"
  effective_config_dir="${meta_config_dir:-$(speco_config_dir_resolve)}"
  if [ -n "$effective_config_dir" ]; then
    config_check="$(speco_config_check "$effective_config_dir")"
    detail "config   ${effective_config_dir}"
    if [ "$config_check" = "CONFIG_OK" ]; then
      detail "config   OK"
    else
      detail "${c_red}INVALID CONFIG: $(speco_config_check_message "$config_check" "$effective_config_dir")${c_reset}"
    fi
  fi
elif ext="$(pgrep -f -U "$(id -u)" 'speco_n8nrl.py' 2>/dev/null)" && [ -n "$ext" ]; then
  row "Speco" "$(st_running)"; detail "pid(s) ${ext//$'\n'/ } (not managed by this lab)"
elif pid="$(read_pid speco)" && [ -f "$(pidfile speco)" ]; then
  row "Speco" "$(st_warn "WATCHER NOT RUNNING")"
  detail "$(speco_stopped_reason "$pid")"
else
  row "Speco" "$(st_offline)"
  configured_dir="$(speco_runtime_dir_resolve)"
  if [ -z "$configured_dir" ]; then
    detail "runtime not configured — see docs/LAB_RUNTIME.md"
  fi
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
