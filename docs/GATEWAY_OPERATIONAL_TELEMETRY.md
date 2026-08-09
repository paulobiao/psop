# Gateway Operational Telemetry

PSOP records operational metadata reported by the manually started edge agent whenever an authenticated telemetry heartbeat successfully reaches the API.

## Reported metadata

- edge agent version
- runtime start time
- last reported runtime uptime
- current API delivery state as observed by the API
- previous local delivery state
- local pending-buffer count at the time of the report
- last successful API delivery
- last delivery error and timestamp
- runtime-report freshness

## Manual-only execution

This feature does not install a service, create a LaunchAgent, start at login, or run the gateway in the background.

The operator starts the gateway explicitly for a test:

```bash
pnpm run gateway:run
```

and stops it with `Control + C`.

## API-outage truth boundary

Operational telemetry cannot reach the PSOP API while that API is unavailable. During an outage the dashboard therefore retains the last received runtime report and its age increases.

After API connectivity returns, the edge agent flushes its last-write-wins heartbeat buffer and reports recovery metadata, including the previous delivery result and the last delivery error.

PSOP must never present a stale runtime report as proof that the edge agent is currently running.

## Gateway-managed child devices

Runtime telemetry describes the edge agent / directly monitored gateway or recorder. It does not prove that an individual camera behind that gateway is streaming or recording.

`VIA_GATEWAY` equipment remains explicitly marked as individually unverified.
