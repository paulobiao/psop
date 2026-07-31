# PSOP Edge Gateway MVP

## Objective

The Edge Gateway converts the laboratory telemetry flow into a practical local-network monitoring path for cameras, DVRs, and NVRs.

```text
Camera / DVR / NVR
        ↓
TCP / HTTP / HTTPS / RTSP probes
        ↓
PSOP Edge Gateway
        ↓
Authenticated ingestion
        ↓
PostgreSQL, events, alerts, dashboard
```

## Health model

- all required probes succeed: `ONLINE`
- some required probes succeed: `DEGRADED`
- no required probe succeeds: the camera heartbeat is withheld so PSOP's expected-heartbeat policy transitions it to `OFFLINE`

## Resilience

When the PSOP API is unavailable, the gateway stores the latest unsent reachable-state snapshot in SQLite. It uses last-write-wins buffering to avoid stale replay storms.

## Security

- the device key is not stored in JSON;
- `.env.local` and `gateway.local.json` are mode `600` and ignored by Git;
- logs never print the raw key;
- no inbound port is opened by the gateway.

## MVP limitation

The gateway currently verifies network and service reachability. Vendor-specific recording state, disk health, analytics, and configuration require ONVIF or manufacturer integrations in later phases.
