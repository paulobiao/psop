# Device Health Operations

> **Superseded by [Operational Health Engine V2](./OPERATIONAL_HEALTH_ENGINE_V2.md).**
> The single collapsed `connectivity.state` described below is now a
> backward-compatibility alias. The current model splits **connectivity**
> (`connectivity.linkState`), **health** (`health.state`) and **collection
> quality** (`collection.state`) into three independent dimensions. Read the V2
> doc first; the sections below describe the legacy alias only.

## Purpose

This milestone adds deterministic operational-health classification to PSOP while preserving the existing AWS IoT Core and DynamoDB integrations.

## Health states (legacy alias `connectivity.state`)

PSOP classifies monitored cameras as:

- `ONLINE`: heartbeat is current and telemetry is healthy;
- `DEGRADED`: compat alias only — the link is ONLINE but `health.state` is DEGRADED/CRITICAL;
- `OFFLINE`: heartbeat age exceeded the permitted interval;
- `NEVER_SEEN`: no telemetry has been received;
- `UNKNOWN`: telemetry exists without a valid timestamp, or the reported status is unrecognised.

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

The original milestone required no migration. Operational Health Engine V2 adds
one **additive, nullable** migration
(`20260829120000_operational_health_engine_v2`): `collection_state`,
`collection_issues`, `capabilities` columns on `device_telemetry_snapshots`.

This milestone does not create, delete or modify AWS resources.
