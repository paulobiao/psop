# Operational Incident History

PSOP derives operational incidents from persisted `DEVICE_CONNECTIVITY` alerts.

Each incident records:

- directly monitored device and site identity;
- severity and current incident status;
- opening, last detection and recovery timestamps;
- measured duration in seconds;
- final connectivity state;
- monitoring source.

Open incidents calculate duration through the overview generation time. Resolved incidents use their persisted recovery timestamp.

## Honest monitoring boundary

Incident records are created only for equipment with direct telemetry. Assets configured as `VIA_GATEWAY` remain outside individual incident claims because a gateway heartbeat does not verify the child camera stream, recording or device health.

## Dashboard

The **Incidents** view provides:

- all, ongoing and recovered filters;
- search by device, external ID, site or title;
- incident duration;
- opening and recovery time;
- direct-telemetry source labeling.

Device details also show the duration of each alert record.
