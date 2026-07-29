# Telemetry Demo Lab

## Purpose

Telemetry Demo Lab provides a local, controlled demonstration of PSOP camera health without modifying or calling AWS services.

## Activation

Set:

```text
TELEMETRY_DEMO_MODE=true
```

The VS Code task `PSOP: Start Telemetry Demo Lab` starts the API with demo mode enabled together with the dashboard.

## Supported states

- `ONLINE`
- `DEGRADED`
- `OFFLINE`
- `NEVER_SEEN`
- `UNKNOWN`

The selected state is held in API memory and resets when the API process restarts.

## Operational behavior

After a state is applied:

1. telemetry is generated locally;
2. device health is evaluated;
3. connectivity events are stored in local process memory;
4. warning or critical alerts are synchronized in PostgreSQL;
5. the dashboard refreshes automatically.

Returning a device to `ONLINE` resolves its active connectivity alert.

## Security

Demo controls preserve JWT authentication, role enforcement, organization isolation and camera-only validation.

## Infrastructure safety

Demo mode bypasses DynamoDB telemetry and connectivity-event reads and writes. It does not create, delete or modify AWS resources.
