# Device Health Operations

## Purpose

This milestone adds deterministic operational-health classification to PSOP while preserving the existing AWS IoT Core and DynamoDB integrations.

## Health states

PSOP classifies monitored cameras as:

- `ONLINE`: heartbeat is current and telemetry is healthy;
- `DEGRADED`: heartbeat is current, but telemetry contains warning conditions;
- `OFFLINE`: heartbeat age exceeded the permitted interval;
- `NEVER_SEEN`: no telemetry has been received;
- `UNKNOWN`: telemetry exists without a valid timestamp.

## Degradation signals

A current device becomes degraded when one or more conditions are present:

- reported status is not recognized as healthy;
- temperature reaches the warning threshold;
- storage utilization reaches the warning threshold.

Defaults:

- temperature: 70°C;
- storage utilization: 90%;
- offline window: two times the expected heartbeat interval.

Environment variables can override these thresholds.

## Dashboard workflow

The dashboard displays degraded devices in:

- operations summaries;
- state filters;
- fleet prioritization;
- site summaries;
- device details and health reasons.

Administrators and operators can trigger an immediate fleet evaluation through the existing protected API endpoint.

## Automated evidence

Permanent unit tests validate every health state, configured thresholds, boundary behavior and simultaneous degradation reasons.

PostgreSQL-backed integration tests validate:

- device creation and update;
- organization-scoped inventory;
- denial of cross-organization site assignment;
- denial of cross-organization device access;
- viewer read-only enforcement.

## Infrastructure safety

No migration is required.

This milestone does not create, delete or modify AWS resources.
