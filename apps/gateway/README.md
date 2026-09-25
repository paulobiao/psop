# PSOP Edge Gateway MVP

The gateway monitors a camera, DVR, or NVR on the local network and sends authenticated heartbeats to PSOP.

## Capabilities

- TCP, HTTP, HTTPS, and RTSP reachability probes
- ONLINE, DEGRADED, and OFFLINE classification
- camera-specific PSOP authentication
- last-write-wins SQLite buffering while the API is unavailable
- one-shot diagnosis or continuous operation
- no third-party Python dependencies
- operational runtime metadata reported to PSOP after successful API delivery

## Configure

```bash
python3 apps/gateway/configure_gateway.py
```

The device key is stored separately in `.env.local`; local files are mode `600` and ignored by Git.

## Diagnose

```bash
python3 apps/gateway/psop_gateway.py --config apps/gateway/gateway.local.json --diagnose
```

## Run once

```bash
bash apps/gateway/run_gateway.sh --config apps/gateway/gateway.local.json --once
```

## Run continuously

```bash
bash apps/gateway/run_gateway.sh --config apps/gateway/gateway.local.json
```

When no required probe succeeds, the gateway withholds the camera heartbeat. PSOP then marks the camera OFFLINE through its existing heartbeat policy instead of receiving a false fresh heartbeat from the gateway.

## Operational telemetry

Each eligible heartbeat includes edge-agent version, runtime start/uptime, pending-buffer count and the previous local delivery result. The API records a successful delivery snapshot and keeps the last delivery error for operational evidence.

The dashboard treats aged runtime reports as stale; it does not infer that the gateway is currently running when no fresh report has arrived.

See `docs/GATEWAY_OPERATIONAL_TELEMETRY.md`.

## Manual operation policy

The gateway runs only when an operator starts it for a test or demonstration. It does not install a macOS service, start at login, or continue after the terminal process is stopped.

Diagnose the local target:

```bash
python3 apps/gateway/psop_gateway.py \
  --config apps/gateway/gateway.local.json \
  --diagnose
```

Run one monitoring cycle:

```bash
bash apps/gateway/run_gateway.sh \
  --config apps/gateway/gateway.local.json \
  --once
```

Run continuously during a test:

```bash
bash apps/gateway/run_gateway.sh \
  --config apps/gateway/gateway.local.json
```

Stop continuous execution with `Control + C`.

The SQLite buffer remains available during manual execution. If the PSOP API is temporarily unavailable, the latest eligible heartbeat is buffered and delivered after the API returns while the gateway process is still running.

See `docs/GATEWAY_MANUAL_OPERATION.md`.

## Video assurance contracts

The E4–E6 shared contract and URI sanitizer are documented in [Video Assurance Foundation](../../docs/VIDEO_ASSURANCE_FOUNDATION.md). Existing RTSP reachability probes do not establish E5 or E6. Real stream discovery and media collection are not yet implemented.
