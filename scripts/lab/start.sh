#!/usr/bin/env bash
#
# pnpm lab:start - bring up the PSOP local laboratory.
#
# Order: Postgres (Docker) -> API (:3100) -> wait for /health -> Dashboard
# (:5173) -> Lorex gateway -> Speco NVR watcher -> summary.
#
# A failure in one service is reported but does not tear down the others.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

cd "$REPO_ROOT"

FAIL=0

# --- 1. PostgreSQL --------------------------------------------------------

log "==> PostgreSQL (${PG_CONTAINER})"
case "$(pg_state)" in
  "running healthy"|"running none")
    ok "    ${PG_CONTAINER} is up and healthy"
    ;;
  "running "*)
    warn "    ${PG_CONTAINER} is running but not healthy yet — waiting up to 60s"
    for _ in $(seq 1 30); do pg_online && break; nap 2; done
    pg_online && ok "    ${PG_CONTAINER} healthy" || { err "    ${PG_CONTAINER} did not become healthy"; FAIL=1; }
    ;;
  stopped|absent)
    if [ -f "$COMPOSE_FILE" ] && command -v docker >/dev/null 2>&1; then
      warn "    ${PG_CONTAINER} is not running — starting it via the project's compose file"
      warn "    (this only touches the '${PG_CONTAINER}' service; no other containers are affected)"
      if docker compose -f "$COMPOSE_FILE" up -d postgres >/dev/null 2>&1; then
        for _ in $(seq 1 30); do pg_online && break; nap 2; done
        pg_online && ok "    ${PG_CONTAINER} healthy" || { err "    ${PG_CONTAINER} did not become healthy"; FAIL=1; }
      else
        err "    Failed to start ${PG_CONTAINER}. Start it manually:"
        err "      docker compose -f infra/docker/compose.yml up -d postgres"
        FAIL=1
      fi
    else
      err "    ${PG_CONTAINER} is not running and Docker/compose is unavailable."
      err "    Start it manually, then re-run: pnpm lab:start"
      FAIL=1
    fi
    ;;
esac

if [ "$FAIL" -ne 0 ]; then
  err "Postgres is not available — not starting the rest of the lab."
  exit 1
fi

# --- 2. API (:3100) -----------------------------------------------------

log "==> API (:${API_PORT})"
if api_healthy; then
  if service_running api; then
    ok "    API already running and healthy (pid $(read_pid api)) — reusing it"
  else
    ok "    A healthy PSOP API is already answering on :${API_PORT} — reusing it (not managed by this lab)"
  fi
else
  in_use="$(port_pids "$API_PORT")"
  if [ -n "$in_use" ]; then
    err "    Port ${API_PORT} is in use (pid(s): ${in_use//$'\n'/ }) but /health is not OK."
    err "    Leaving that process alone. Investigate: tail -f $(logfile api)"
    exit 1
  fi
  log "    starting: LOCAL_TELEMETRY_INGESTION_ENABLED=true pnpm --filter api start:dev"
  export LOCAL_TELEMETRY_INGESTION_ENABLED=true
  pid="$(spawn api bash -c "cd '$REPO_ROOT' && exec pnpm --filter api start:dev")"
  unset LOCAL_TELEMETRY_INGESTION_ENABLED
  log "    api pid ${pid} — log: $(logfile api)"
fi

# --- 3. Wait for /health ---------------------------------------------

if ! api_healthy; then
  log "==> Waiting for ${HEALTH_URL}"
  deadline=$((SECONDS + 90))
  until api_healthy; do
    if ! service_running api; then
      err "    API process exited before becoming healthy. Last log lines:"
      tail -n 30 "$(logfile api)" >&2 || true
      exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      err "    API did not become healthy within 90s. Last log lines:"
      tail -n 30 "$(logfile api)" >&2 || true
      exit 1
    fi
    nap 2
  done
fi
ok "    API healthy: ${HEALTH_URL}"

# --- 4. Dashboard (:5173) ------------------------------------------

log "==> Dashboard (:${DASH_PORT})"
if service_running dashboard || dash_responding; then
  if service_running dashboard; then
    ok "    Dashboard already running (pid $(read_pid dashboard)) — reusing it"
  else
    ok "    Something is already serving :${DASH_PORT} — reusing it (not managed by this lab)"
  fi
else
  in_use="$(port_pids "$DASH_PORT")"
  if [ -n "$in_use" ]; then
    warn "    Port ${DASH_PORT} is in use (pid(s): ${in_use//$'\n'/ }) but not responding to HTTP — leaving it alone, skipping dashboard"
  else
    log "    starting: pnpm --filter dashboard dev"
    pid="$(spawn dashboard bash -c "cd '$REPO_ROOT' && exec pnpm --filter dashboard dev")"
    log "    dashboard pid ${pid} — log: $(logfile dashboard)"
    for _ in $(seq 1 30); do dash_responding && break; service_running dashboard || break; nap 1; done
    dash_responding && ok "    Dashboard responding: ${DASH_URL}" \
      || warn "    Dashboard not confirmed yet — check: tail -f $(logfile dashboard)"
  fi
fi

# --- 5. Lorex gateway --------------------------------------------------

log "==> Lorex gateway"
ext_lorex="$(pgrep -f -U "$(id -u)" 'psop_gateway.py' 2>/dev/null || true)"
if service_running lorex; then
  ok "    Lorex gateway already running (pid $(read_pid lorex)) — reusing it"
elif [ -n "$ext_lorex" ]; then
  warn "    A psop_gateway.py process is already running (pid(s): ${ext_lorex//$'\n'/ }) — not starting another"
elif [ ! -f "$REPO_ROOT/apps/gateway/.env.local" ]; then
  warn "    apps/gateway/.env.local is missing — skipping Lorex gateway"
  warn "    (configure it with: python3 apps/gateway/configure_gateway.py)"
else
  log "    starting: bash apps/gateway/run_gateway.sh --config apps/gateway/gateway.local.json"
  pid="$(spawn lorex bash -c "cd '$REPO_ROOT' && exec bash apps/gateway/run_gateway.sh --config apps/gateway/gateway.local.json")"
  nap 1
  service_running lorex \
    && { log "    lorex pid ${pid} — log: $(logfile lorex)"; ok "    Lorex gateway started"; } \
    || { err "    Lorex gateway exited immediately. Last log lines:"; tail -n 20 "$(logfile lorex)" >&2 || true; }
fi

# --- 6. Speco NVR watcher -------------------------------------------
#
# Speco is the one lab service with an explicit, fail-closed runtime
# selection (docs/LAB_RUNTIME.md): it never falls back to "whatever is
# checked out in this worktree" — that exact behavior previously produced
# a multi-hour incident with a stale pre-fix watcher against real hardware.

log "==> Speco NVR watcher"
ext_speco="$(pgrep -f -U "$(id -u)" 'speco_n8nrl.py' 2>/dev/null || true)"
if service_running speco; then
  ok "    Speco watcher already running (pid $(read_pid speco)) — reusing it"
elif [ -n "$ext_speco" ]; then
  warn "    A speco_n8nrl.py process is already running (pid(s): ${ext_speco//$'\n'/ }) — not starting another"
else
  SPECO_RUNTIME_DIR="$(speco_runtime_dir_resolve)"
  SPECO_RUNTIME_CHECK="$(speco_runtime_check "$SPECO_RUNTIME_DIR")"

  if [ "$SPECO_RUNTIME_CHECK" != "OK" ]; then
    warn "    Speco runtime is not ready — refusing to start (fail-closed)."
    warn "    $(speco_runtime_check_message "$SPECO_RUNTIME_CHECK" "$SPECO_RUNTIME_DIR")"
    if [ "$SPECO_RUNTIME_CHECK" = "NOT_CONFIGURED" ]; then
      warn "    Configure it once with either:"
      warn "      export PSOP_SPECO_RUNTIME_DIR=/path/to/runtime/apps/gateway"
      warn "    or add a line to $(_lab_runtime_env_file):"
      warn "      PSOP_SPECO_RUNTIME_DIR=/path/to/runtime/apps/gateway"
    fi
    warn "    See docs/LAB_RUNTIME.md. Skipping Speco watcher."
  else
    SPECO_CONFIG_DIR="$(speco_config_dir_resolve)"
    SPECO_PW="$(speco_password_from_keychain "$SPECO_CONFIG_DIR" || true)"
    if [ -z "$SPECO_PW" ]; then
      speco_keychain_hint "$SPECO_CONFIG_DIR"
      warn "    Skipping Speco watcher until the Keychain entry exists."
    else
      log "    runtime: ${SPECO_RUNTIME_DIR} (source: $(speco_runtime_dir_source))"
      log "    starting: python3 speco_n8nrl.py --watch --interval 30"
      # Exported into the environment only (never on a command line, so it does
      # not appear in `ps`); the already-forked child keeps its copy after unset.
      export PSOP_SPECO_PASSWORD="$SPECO_PW"
      pid="$(spawn speco \
        bash -c "cd '$SPECO_RUNTIME_DIR' && exec python3 speco_n8nrl.py --watch --interval 30")"
      unset PSOP_SPECO_PASSWORD SPECO_PW
      nap 2
      if service_running speco; then
        speco_runtime_metadata_write "$SPECO_RUNTIME_DIR" \
          "$(speco_runtime_head "$SPECO_RUNTIME_DIR")" "$SPECO_RUNTIME_CHECK"
        log "    speco pid ${pid} — log: $(logfile speco)"
        ok "    Speco watcher started"
      else
        err "    Speco watcher exited immediately. Last log lines:"
        tail -n 20 "$(logfile speco)" >&2 || true
      fi
    fi
  fi
fi

# --- 7. Summary ------------------------------------------------------

echo
echo "PSOP LAB"
echo "--------------------------------"
pg_online                 && row "PostgreSQL"    "$(st_online)"                    || row "PostgreSQL"    "$(st_offline)"
api_healthy               && row "API"           "$(st_online) :${API_PORT}"       || row "API"           "$(st_offline)"
(service_running dashboard || dash_responding) \
                          && row "Dashboard"     "$(st_online) :${DASH_PORT}"      || row "Dashboard"     "$(st_offline)"
if service_running speco || [ -n "${ext_speco:-}" ]; then row "Speco NVR" "$(st_running)"; else row "Speco NVR" "$(st_warn "NOT CONFIGURED")"; fi
if service_running lorex || [ -n "${ext_lorex:-}" ]; then row "Lorex Gateway" "$(st_running)"; else row "Lorex Gateway" "$(st_offline)"; fi
echo
echo "Dashboard:"
echo "  ${DASH_URL}"
echo
echo "Logs:     ${LOG_DIR}"
echo "Status:   pnpm lab:status"
echo "Stop:     pnpm lab:stop"
