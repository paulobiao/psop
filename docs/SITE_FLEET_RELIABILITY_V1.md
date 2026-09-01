# Site & Fleet Reliability V1

> "How reliable has this **site** been?" and "How reliable is the whole
> **fleet / organization**?" — aggregated from per-device availability.
> **Additive and strictly read-only.** Builds on
> [Operational Health Engine V2](./OPERATIONAL_HEALTH_ENGINE_V2.md) and
> [Operational History & Availability V1](./OPERATIONAL_HISTORY_AVAILABILITY_V1.md);
> it never re-implements either. **No migration. No score. No ranking.**

## What it answers

| Endpoint | Question |
|---|---|
| `GET /api/v1/sites/:siteId/reliability` | How reliable has this site's monitored fleet been over the period? |
| `GET /api/v1/fleet/reliability` | Same, consolidated across every site of the authenticated organization. |

Both accept the **same period semantics** as `GET /devices/:id/availability`:

- `?window=24h` \| `7d` \| `30d` (default `24h`), or
- `?from=<ISO>&to=<ISO>` (explicit range wins; `to` defaults to *now* and is
  always clamped to *now* — the future is never uptime).

The query parser is literally `DeviceAvailabilityService.resolveAvailabilityPeriod`
— one period is resolved once and handed to every device in the population.

## Sources — nothing new is stored

| Fact | Source |
|---|---|
| Population (which devices count) | `DeviceService.findAllReliabilityEligibleDevicesWithSite(orgId)` → `DeviceRepository.findAllReliabilityEligibleDevicesWithSite`: the canonical "observable device" predicate (same `OBSERVABLE_DEVICE_OR` used by `findAllObservableDevicesWithSite`) **plus `status === ACTIVE`**. Filtered to the site for the site endpoint. |
| Excluded-population accounting | `DeviceService.findAll(orgId)` minus the eligible set; each remainder classified by `classifyExclusion`. |
| Per-device history & availability | `DeviceAvailabilityService.reconstructForResolvedDevice(...)` — the **exact** Availability V1 pipeline that backs `GET /devices/:id/availability`. |
| Per-device current state | Health Engine V2 (`DeviceTelemetryService.findByDeviceId`), consumed through the reconstruction, **verbatim**. |

The reliability endpoints depend only on `DeviceService`, `DeviceAvailabilityService`
and `SiteService` — no repository is exported across a module boundary for this
feature.

**No migration.** Everything is calculable from devices/sites already in
Postgres, the `DeviceConnectivityEvent` transition log, and the live Health
Engine evaluation. A materialized aggregate table would only be a performance
optimization; V1 does not add one (see [Performance](#performance)).

## The aggregate unit: device-time

For a population of **N** eligible devices over a period of **T** seconds:

```
expectedDeviceSeconds   = T * N
uptimeDeviceSeconds     = Σ device.availability.uptimeSeconds
downtimeDeviceSeconds   = Σ device.availability.downtimeSeconds
unknownDeviceSeconds    = Σ (unknownSeconds + neverSeenSeconds + noDataSeconds)
confirmedDeviceSeconds  = uptimeDeviceSeconds + downtimeDeviceSeconds

coveragePercentage              = confirmedDeviceSeconds / expectedDeviceSeconds * 100
confirmedAvailabilityPercentage = uptimeDeviceSeconds   / confirmedDeviceSeconds * 100   (when confirmedDeviceSeconds > 0)
```

### When is `aggregateAvailability.percentage` a number?

`percentage` is the availability of the **whole period for the whole eligible
population**. It is a number **only** when:

```
eligibleDeviceCount > 0
AND confirmedDeviceSeconds > 0
AND unknownDeviceSeconds === 0        (unknownDeviceSeconds = Σ UNKNOWN + NEVER_SEEN + NO_DATA)
```

Otherwise `percentage = null` and `unavailableReason` is set:

| `unavailableReason` | Meaning |
|---|---|
| `NO_ELIGIBLE_DEVICES` | The site/org has no operationally-monitored devices. `percentage` is `null` — **never `100`**. |
| `NO_CONFIRMED_OBSERVATION` | Devices exist but not one second of confirmed `ONLINE`/`OFFLINE` was observed across the population. |
| `INCOMPLETE_COVERAGE` | Part of the population's device-time is `UNKNOWN` / `NEVER_SEEN` / `NO_DATA`. Use `confirmedAvailabilityPercentage` (availability over the observed device-time) and `coveragePercentage` (how much that is). |

The gate is `unknownDeviceSeconds === 0` — a fully-covered device contributes
zero `UNKNOWN`/`NEVER_SEEN`/`NO_DATA` device-seconds. Per-device Availability V1
rounds each segment to whole seconds, so `confirmedDeviceSeconds` and
`expectedDeviceSeconds` can differ by a few seconds even at full coverage; that
sub-second slack is **deliberately not** the gate, so rounding can never promote
a real coverage gap to a complete one (nor demote a genuinely-covered
population). Partial coverage never slips through as an official figure, and
**missing information is never counted as uptime**. There is no 90/95/99%
threshold anywhere.

### Why not a simple mean of percentages?

The organization figure is recomputed from the **total device-seconds** of every
eligible device in every site — **not** the mean of the per-site `percentage`
values.

> Example: Site X has 1 device, 100% down. Site Y has 99 devices, 100% up.
> Mean of site percentages = `(0 + 100) / 2 = 50%`.
> Device-seconds = `99·T / 100·T = 99%`.

A 1-device site and a 100-device site do not carry equal mathematical weight
unless a future model deliberately says so. The per-site rows in the fleet
response still expose each site's own independent `percentage` /
`confirmedAvailabilityPercentage` / `coveragePercentage`.

## Why this is **not** "site uptime"

`aggregateAvailability` is availability aggregated by **device-time**: every
device-second is weighted equally. It is **not** a statement that "the site as a
service was operational X% of the period" — that would require a separate
service-level definition (which devices must be up for the site to be
"serviceable", redundancy, etc.) that this V1 does not assume. The field is named
`aggregateAvailability` on purpose. Every response also carries `limitations[]`
restating this in plain language.

## Eligible devices

The population is `DeviceRepository.findAllReliabilityEligibleDevicesWithSite`:
the shared observability predicate (identical `OBSERVABLE_DEVICE_OR` clause used
by `findAllObservableDevicesWithSite` — no divergent copy) **plus**
`status === ACTIVE`:

```
eligible = status = ACTIVE
       AND ( (monitoringMode = DIRECT      AND deviceType ∈ {CAMERA, RECORDER, GATEWAY})
           OR (monitoringMode = VIA_GATEWAY AND deviceType = CAMERA AND gatewayDeviceId set) )
```

Everything else is excluded and counted in `population.excludedByReason`
(`classifyExclusion` reports the structural reason first, since it holds
regardless of status):

| Reason | Case |
|---|---|
| `INVENTORY_ONLY` | `monitoringMode = INVENTORY_ONLY` |
| `DEVICE_TYPE_NOT_MONITORED` | `DIRECT` device whose type is not `CAMERA`/`RECORDER`/`GATEWAY` |
| `GATEWAY_CHILD_NOT_CAMERA` | `VIA_GATEWAY` device that is not a `CAMERA` |
| `GATEWAY_CHILD_WITHOUT_RECORDER` | `VIA_GATEWAY` camera with no recorder/gateway assigned |
| `ADMINISTRATIVE_STATUS_NOT_ACTIVE` | structurally observable, but `status` is `INACTIVE` / `MAINTENANCE` / `DECOMMISSIONED` (counted together) |

### Why `status === ACTIVE`

PSOP's operational **ingestion** already requires `status === ACTIVE`:
`device-telemetry-ingestion.service` rejects direct device and recorder
telemetry from non-`ACTIVE` devices, and `recorder-observation.service` only
matches child cameras with `status === ACTIVE`. A non-`ACTIVE` device therefore
cannot keep its operational telemetry current; if it stayed in the reliability
population its data would simply age and drag `coveragePercentage` /
`aggregateAvailability` down indefinitely — for a single stale recorder-observed
camera, enough to force the whole site's and the whole fleet's `percentage` to
`null` forever.

Decision for V1:

| `status` | In reliability population? |
|---|---|
| `ACTIVE` | **included** |
| `INACTIVE` | **excluded** |
| `DECOMMISSIONED` | **excluded** |
| `MAINTENANCE` | **excluded** — PSOP has no planned-maintenance-window model in V1; a dedicated maintenance semantics may come later |

This is **"current fleet reliability population eligibility"**, which is distinct
from **"historical queryability"**: `GET /devices/:id/availability` is
**unchanged** and still returns the full history for a non-`ACTIVE` device.
Only `findAllReliabilityEligibleDevicesWithSite` filters on status — every other
surface (`GET /devices/:id/availability`, Health Engine `current.*`, Operations
Overview) is untouched.

## Recorder (NVR) ↔ child camera semantics

The reconstruction is per-device and the Health Engine V2 semantics are
preserved unchanged:

| Situation | Effect on the aggregate |
|---|---|
| A child camera physically drops | Recorder-verified `OFFLINE` on **that child** → child `downtimeSeconds` only. The NVR keeps its own independent `ONLINE` timeline. Other children unaffected. |
| The NVR loses observability | If the NVR itself goes `OFFLINE`, that is **one** confirmed outage of the NVR. Its children's telemetry goes stale → Health Engine marks them `UNKNOWN` → child `unknownSeconds` grows → **coverage drops**. It is **never** counted as child downtime, and it is **not** "one outage per observed child". |

`outages.total` is `Σ` of each device's `OFFLINE`-interval count.
`outages.devicesAffected` counts distinct devices with ≥ 1 `OFFLINE` interval
(no double counting). A recorder that stopped observing 3 children while itself
staying reachable contributes `0` outages and `0` downtime; the 3 children
contribute `0` downtime and a coverage gap.

**No root-cause correlation.** V1 never says "the recorder caused the child
outage" — the data does not assert that.

## Current state

`current.{online,offline,unknown,neverSeen}` comes straight from Health Engine V2
per device (`connectivity.linkState`) and is **independent of the requested
history window**. It is never reconstructed from historical availability.

- Collection `PARTIAL` / `FAILED` never changes `current`.
- Health `DEGRADED` / `CRITICAL` is never `OFFLINE` and never downtime.
- A device with a `null` link verdict is counted as `unknown` — never assumed online.
- A device that was down earlier in the window but is `ONLINE` now shows in
  `current.online`; its historical downtime still appears in the aggregate.

`health` is intentionally **not** folded into the reliability math. If a health
breakdown is wanted it can be added as a separate block later.

## The four dimensions, kept distinct

| Dimension | Question | Where |
|---|---|---|
| **connectivity** (`linkState`) | Is the device reachable / observed right now? | Health Engine V2 → `current.*` |
| **health** | Is the equipment operationally healthy (temp, storage, recording)? | Health Engine V2 — **not** in reliability math |
| **collection** | Did the adapter read every expected capability? | Health Engine V2 — diagnostics only, **not** in reliability math |
| **availability** (per device) | How long was *this device* `OFFLINE` / observed, over the period? | Availability V1 |
| **site / fleet reliability** | Device-time availability aggregated over a population, with honest coverage. | this doc |

## Outage summary

Objective metrics only:

- `total` — Σ outage-interval count over the population
- `devicesAffected` — distinct devices with ≥ 1 outage
- `totalDowntimeDeviceSeconds` — Σ downtime device-seconds (== `downtimeDeviceSeconds`)
- `longest` — the single longest `OFFLINE` interval across the population
  (`{deviceId, deviceName, startedAt, endedAt, durationSeconds, open}`)
- `lastOutageAt` — most recent outage `startedAt`
- `lastConfirmedRecoveryAt` — most recent `OFFLINE → ONLINE` transition
  (an `OFFLINE → UNKNOWN`/`NEVER_SEEN` transition never sets this)

Devices and sites are ordered by **downtime DESC** (then name). This is
**ordering by an objective measure, not an intelligent ranking**. There is no
reliability score, risk score, severity, AI confidence or predicted failure
anywhere in the contract.

## Contracts

### `GET /api/v1/sites/:siteId/reliability`

```jsonc
{
  "generatedAt": "…",
  "site": { "id": "…", "code": "…", "name": "…", "timezone": "…", "status": "ACTIVE" },
  "period": {
    "requestedFrom": "…", "requestedTo": "…", "from": "…", "to": "…",
    "durationSeconds": 86400, "window": "24h" | null, "clampedToNow": false
  },
  "population": {
    "eligibleDevices": 6,
    "excludedDevices": 1,
    "excludedByReason": { "INVENTORY_ONLY": 1 }
  },
  "current": { "online": 5, "offline": 1, "unknown": 0, "neverSeen": 0 },
  "aggregateAvailability": {
    "percentage": 96.5278 | null,
    "confirmedAvailabilityPercentage": 96.5278 | null,
    "coveragePercentage": 100 | null,
    "uptimeDeviceSeconds": 500400,
    "downtimeDeviceSeconds": 18000,
    "unknownDeviceSeconds": 0,
    "expectedDeviceSeconds": 518400,
    "confirmedDeviceSeconds": 518400,
    "unavailableReason": null | "NO_ELIGIBLE_DEVICES" | "NO_CONFIRMED_OBSERVATION" | "INCOMPLETE_COVERAGE"
  },
  "outages": {
    "total": 2,
    "devicesAffected": 2,
    "totalDowntimeDeviceSeconds": 18000,
    "longest": { "deviceId": "…", "deviceName": "…", "startedAt": "…", "endedAt": "…" | null, "durationSeconds": 10800, "open": false } | null,
    "lastOutageAt": "…" | null,
    "lastConfirmedRecoveryAt": "…" | null
  },
  "devices": [
    {
      "deviceId": "…", "name": "…", "deviceType": "CAMERA", "monitoringMode": "DIRECT",
      "currentLinkState": "ONLINE" | "OFFLINE" | "UNKNOWN" | "NEVER_SEEN" | null,
      "availabilityPercentage": 91.6 | null,
      "confirmedAvailabilityPercentage": 91.6 | null,
      "coveragePercentage": 100,
      "uptimeSeconds": 79200, "downtimeSeconds": 7200, "unknownSeconds": 0,
      "outageCount": 1, "longestOutageSeconds": 7200, "lastOutageAt": "…" | null
    }
    // … ordered by downtimeSeconds DESC, then name
  ],
  "limitations": [ "…" ]
}
```

### `GET /api/v1/fleet/reliability`

Same shape, organization-scoped, plus a per-site breakdown:

```jsonc
{
  "generatedAt": "…",
  "organizationId": "…",
  "period": { … },
  "population": {
    "sites": 4,
    "sitesWithEligibleDevices": 3,
    "eligibleDevices": 8,
    "excludedDevices": 1,
    "excludedByReason": { "INVENTORY_ONLY": 1 }
  },
  "current": { "online": 6, "offline": 1, "unknown": 0, "neverSeen": 1 },
  "aggregateAvailability": { … },   // recomputed from ALL device-seconds
  "outages": { … },
  "sites": [
    {
      "siteId": "…", "siteName": "…", "code": "…",
      "eligibleDevices": 6, "currentOffline": 1,
      "availabilityPercentage": 96.5278 | null,
      "confirmedAvailabilityPercentage": 96.5278 | null,
      "coveragePercentage": 100 | null,
      "uptimeDeviceSeconds": 500400, "downtimeDeviceSeconds": 18000,
      "outageCount": 2,
      "unavailableReason": null | "…"
    }
    // … ordered by downtimeDeviceSeconds DESC, then name
  ],
  "limitations": [ "…" ]
}
```

> The contract uses `code` (the `Site.code` column) rather than an `externalId`
> — PSOP sites have no separate external id.

## Tenant isolation

- **Site:** `SiteRepository.findById(siteId, organizationId)` → a site outside
  the caller's organization is a **`404` "Site not found"**, indistinguishable
  from one that never existed. A malformed id is `400` (UUID pipe).
- **Fleet:** every query is scoped by `user.organizationId`; sites and devices of
  other organizations never appear in any field — not in the site list, device
  rows, outage metadata, `longest`, `observerDeviceName`, or the summaries.

## Read-only

Both endpoints are `GET` and touch **no** write path: no incident, no telemetry
write, no `lastSeen` / `observedAt` update, no snapshot, no aggregation row, no
alert lifecycle. An e2e test snapshots every telemetry / observation / event /
alert row before and after a batch of calls and asserts equality.

## Performance

Each eligible device is reconstructed with its own Availability V1 read
(1 telemetry read + 1 connectivity-window read, + 1 recent-transition read only
when the link is currently `OFFLINE`), run with bounded concurrency (8). The cost
is therefore **O(devices)** storage reads per call:

- A site call = O(devices in the site).
- A fleet call reconstructs each eligible device **exactly once** and reuses
  those per-device numbers for both the site rows and the organization aggregate.

For V1 this is "correct first". Known limitation: a very large fleet (thousands
of devices) will issue thousands of small reads per request. The clean next step
is a batched telemetry read (`BatchGet`, as `DeviceTelemetryService.findFleet`
already does) plus a batched connectivity-window query — **not** a materialized
table. No caching, no persisted rollup, no migration in V1.

## Not in V1

- Service-level "site up/down" (needs an explicit service definition)
- Any score / risk index / ranking / severity / prediction
- Root-cause correlation between a recorder and its children
- A health or collection-quality rollup in the reliability numbers
- Frontend — `apps/dashboard/` is untouched
- Pagination of the `devices[]` / `sites[]` arrays (ordering only)
