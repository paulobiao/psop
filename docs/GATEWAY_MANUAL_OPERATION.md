# Gateway Manual Operation

The PSOP Edge Gateway is intentionally manual.

It must not install an operating-system service, start automatically after login, or remain running after the operator ends the terminal process.

## Start a test

```bash
cd /Users/paulobiao/02_PROJETOS/BiaoTech-Master/psop

bash apps/gateway/run_gateway.sh \
  --config apps/gateway/gateway.local.json
```

## Stop a test

Press `Control + C` in the terminal running the gateway.

## Diagnostics

```bash
python3 apps/gateway/psop_gateway.py \
  --config apps/gateway/gateway.local.json \
  --diagnose
```

## One cycle

```bash
bash apps/gateway/run_gateway.sh \
  --config apps/gateway/gateway.local.json \
  --once
```

## Buffer behavior

During manual execution, the gateway stores the latest eligible heartbeat in the ignored SQLite buffer when the PSOP API is unavailable. If the API returns before the gateway process is stopped, the pending heartbeat is flushed before normal delivery resumes.

The buffer, configuration and device secret stay under ignored local paths and must not be committed.

## Operational telemetry

While the gateway is manually running, successful heartbeats also report edge-agent runtime metadata to PSOP. The dashboard can show the last runtime report, version, uptime, buffer count, delivery history and last delivery error.

See `docs/GATEWAY_OPERATIONAL_TELEMETRY.md`.

## Operational boundary

Stopping the gateway intentionally ends local monitoring. The dashboard then retains the last known telemetry until the normal heartbeat-expiration policy marks the directly monitored gateway offline.
