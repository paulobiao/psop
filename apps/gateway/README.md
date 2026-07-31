# PSOP Edge Gateway MVP

The gateway monitors a camera, DVR, or NVR on the local network and sends authenticated heartbeats to PSOP.

## Capabilities

- TCP, HTTP, HTTPS, and RTSP reachability probes
- ONLINE, DEGRADED, and OFFLINE classification
- camera-specific PSOP authentication
- last-write-wins SQLite buffering while the API is unavailable
- one-shot diagnosis or continuous operation
- no third-party Python dependencies

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
