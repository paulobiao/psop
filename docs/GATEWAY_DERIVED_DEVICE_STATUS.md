# Gateway-Derived Device Status

PSOP now distinguishes direct telemetry from gateway-derived visibility.

For equipment configured with `VIA_GATEWAY`:

- the gateway connectivity state is displayed;
- the child equipment is not added to direct telemetry totals;
- the child does not receive a false direct `ONLINE`, `OFFLINE` or `NEVER_SEEN` state;
- the interface explicitly states that individual streaming, recording and device health are not verified.

The operations overview exposes `gatewayManaged` records separately from the directly monitored `fleet`. Each record includes the managed device, its gateway, the gateway connectivity snapshot and `individualVerification: NOT_VERIFIED`.

This is intentionally conservative for closed ecosystems where the central gateway is reachable but individual camera telemetry is unavailable.
