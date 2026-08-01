# Monitored Equipment Telemetry

PSOP operational telemetry now includes directly monitored:

- cameras;
- recorders;
- gateways.

Assets using `VIA_GATEWAY` remain visible in inventory and site views, but they do not receive a false `NEVER_SEEN` or `OFFLINE` state merely because the closed gateway ecosystem does not expose individual device telemetry.

The directly monitored gateway can authenticate with its own device credential, send heartbeat telemetry, create connectivity events and participate in alert evaluation.

For backward compatibility, persisted telemetry and connectivity records continue using the existing `camera_id` storage key even when the record belongs to a recorder or gateway.
