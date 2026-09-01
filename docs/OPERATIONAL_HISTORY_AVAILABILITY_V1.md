# Operational History & Availability V1

> Per-device operational history and availability, reconstructed from the
> connectivity transition log. **Additive and strictly read-only.** Builds on
> [Operational Health Engine V2](./OPERATIONAL_HEALTH_ENGINE_V2.md) and
> [Device Intelligence V1](./DEVICE_INTELLIGENCE_V1.md); it never re-implements
> either.

## What it answers

`GET /api/v1/devices/:deviceId/availability?from=…&to=…` (or `?window=24h|7d|30d`)
answers, for one device over one period:

- When did it go offline, and for how long?
- How many outages in the last 24h / 7d / 30d?
- What was its availability in the period?
- When was the last drop and the last recovery?
- What is the accumulated downtime and the single longest outage?
- Is it in an open outage right now, and when did that start?

## Sources — nothing new is stored

Everything is reconstructed from data PSOP already persists:

| Fact | Source |
|---|---|
| Current `linkState` | `DeviceTelemetryService.findByDeviceId(...)` → Health Engine V2, **verbatim**, never recomputed. |
| History (transitions) | `DeviceConnectivityEvent` rows — the log the connectivity monitor already writes on every state change, with the full `context` (reasons, observer, channel, `linkState`). |

**No migration.** The transition log plus the live Health Engine evaluation are
sufficient to rebuild every interval and every number below. A materialised
outage table would only be a performance optimisation and V1 does not need one
(a per-device query over ≤ retention days of *transition* events is tiny).

## Definition of an outage (V1 — connectivity only)

An operational outage **begins** when `connectivity.linkState` becomes
`OFFLINE` and **ends** when it returns to `ONLINE` (or any non-`OFFLINE` state).

Explicitly **not** downtime:

- the legacy collapsed `DEGRADED` alias (it means `linkState = ONLINE`, health degraded);
- health `DEGRADED` / `CRITICAL` (temperature, storage, recording…);
- collection `PARTIAL` / `FAILED` (an optional enrichment gap is diagnostics only);
- `UNKNOWN` (stale observation / invalid timestamp) — *not a confirmed outage*;
- `NEVER_SEEN` — *not a confirmed outage*.

`UNKNOWN`, `NEVER_SEEN` and `NO_DATA` time is measured and reported separately
(`unknownSeconds`, `neverSeenSeconds`, `noDataSeconds`) and **excluded from the
availability denominator** — uptime never absorbs a period PSOP could not
actually observe.

A **recorder-verified child OFFLINE** (`REPORTED_OFFLINE` +
`RECORDER_VERIFIED_OFFLINE`) is a real outage **of that child camera**. It is
recorded against the child device only; the NVR keeps its own independent
timeline. A child going down never creates downtime for its recorder.

### An outage *ending* vs a *confirmed recovery*

These are separate facts:

- **Confirmed downtime accounting** stops as soon as `linkState` stops being
  `OFFLINE` — including `OFFLINE → UNKNOWN` or `OFFLINE → NEVER_SEEN`. The
  interval's `endedAt` / `durationSeconds` reflect that.
- A **confirmed recovery** is *only* `OFFLINE → ONLINE` — the equipment
  actually reported it was back. Each interval carries
  `endedByState` (`ONLINE` | `UNKNOWN` | `NEVER_SEEN` | `null` while open) and
  `recoveryConfirmed` (`true` only for `ONLINE`).
- `outages.lastRecoveryAt` and `recoveryReasonCodes` are populated **only** for
  confirmed recoveries. An `OFFLINE → UNKNOWN` transition never claims the
  device recovered.

## The `linkState` behind a stored event

`DeviceConnectivityEvent.currentState` is the **legacy 5-value alias**
(`ONLINE | DEGRADED | OFFLINE | UNKNOWN | NEVER_SEEN`). The true link dimension
is taken from `context.linkState` when present; otherwise it is derived from the
alias — and `DEGRADED` derives to `ONLINE` (it is a health state). So a health
degradation transition is reconstructed as **uptime**.

## Timeline reconstruction

1. **Anchor** — the single latest transition strictly *before* `from` gives the
   state the device was already in when the window opened. No anchor ⇒ the time
   before the first in-window event is `NO_DATA` (PSOP had no knowledge yet).
2. **Boundaries** — `from` (anchor state) → one boundary per in-window
   transition (clamped into `[from, effectiveTo]`; a later event at the same
   instant wins) → `effectiveTo`.
3. **Segments** — each `[boundary, nextBoundary)` carries one state; its
   duration is added to `uptime` / `downtime` / `unknown` / `neverSeen` /
   `noData`.
4. **Intervals** — a maximal run of `OFFLINE` segments is one outage. Two
   consecutive `OFFLINE` events (e.g. `REPORTED_OFFLINE` then
   `HEARTBEAT_OVERDUE`) stay **one** interval; repeated identical `OFFLINE`
   polls add nothing. The interval closes at the first non-`OFFLINE` boundary,
   whatever that state is — but only `ONLINE` sets `recoveryConfirmed`.

### Boundary / edge cases handled

| Case | Behaviour |
|---|---|
| Outage started before `from` | `clipped.start = true`; `startedAt` = `from`, `actualStartedAt` = the real (earlier) transition; `durationSeconds` counts only the in-window part; `actualDurationSeconds` is the full length. |
| Outage still ongoing at a **historical** `to` | `clipped.end = true`, `open = false`, `endedAt = null`, `recoveryConfirmed = false` (we cannot know when it ended after `to`). |
| Outage ongoing and the window ends **now** | `open = true` when the Health Engine also reports `OFFLINE`. If the Health Engine already reports `ONLINE` but the monitor has not written the transition yet, the interval is closed at `to` with `endedByState = ONLINE` / `recoveryConfirmed = true` and a limitation is emitted; if it reports `UNKNOWN`/`NEVER_SEEN`, `recoveryConfirmed = false`. |
| `OFFLINE → UNKNOWN` / `OFFLINE → NEVER_SEEN` | interval closes (confirmed downtime stops) with `endedByState = UNKNOWN`/`NEVER_SEEN`, `recoveryConfirmed = false`, `recoveryReasonCodes = null`; `lastRecoveryAt` is **not** touched. |
| Zero events, no anchor | whole period `NO_DATA`; `availability.percentage = null`, `confirmedAvailabilityPercentage = null`, `unavailableReason = NO_HISTORY`. |
| `from ≥ to`, future-only `from`, range > 400 days | `400 Bad Request`. |
| `to` in the future | clamped to now (`clampedToNow = true`); the future is never uptime. |
| Device is `OFFLINE` now but the outage began **after** a historical `to` | the historical figures are untouched (`downtimeSeconds`, `outages.count` etc. do not see it). `current.outageOpen = true` and `current.outageStartedAt` is reconstructed from the live connectivity history (see [The `current` block](#the-current-block)); `current.outageStartedWithinWindow = false`; a limitation records that the outage began after the window. |
| Non-UUID id | `400`. Device outside the caller org | `404` (no existence leak). Non-observable device (e.g. `INVENTORY_ONLY` sensor) | `400`. |

## The `current` block

`current.*` describes the device **right now** and is **independent of `from` /
`to`** — the window only governs the historical reconstruction (availability,
downtime, `intervals`, `outages.*`, coverage).

- `current.linkState` is taken **verbatim** from Health Engine V2.
- `current.outageOpen` is `true` **iff** `current.linkState === 'OFFLINE'`.
- `current.outageStartedAt` is the start of the outage that is open now,
  reconstructed **only** from the device's most recent connectivity transitions
  up to `now` — **never** from the in-window reconstruction. The requested
  window may itself carry an open outage at `to` and still be irrelevant to the
  outage running at this instant (e.g. window outage *A* recovers after `to`,
  then outage *B* starts — `current.outageStartedAt` is *B*, not *A*).
  - The recent transitions are scanned newest → oldest (bounded by the
    event-retention horizon). Repeated `OFFLINE` polls do not move the start;
    the run begins at the first `OFFLINE` transition that came from a
    non-`OFFLINE` state; an intervening `ONLINE` / `UNKNOWN` / `NEVER_SEEN`
    ends the previous run and a later `OFFLINE` starts a new one.
  - `null` (outcome `HISTORY_INSUFFICIENT`) when retained history cannot locate
    the start — no transitions at all, the latest recorded transition is not
    `OFFLINE`, or the whole retained tail is `OFFLINE` with no non-`OFFLINE`
    predecessor. The limitation then reads *"The current outage start could not
    be reconstructed from retained connectivity history."* — it never claims
    "no connectivity transition has been recorded", which retention cannot
    prove.
- `current.outageStartedWithinWindow` is `true` only when that start falls
  inside `[from, to]`.

## Availability math

Two figures, deterministically separated so a partly-observed period can never
produce a misleading number:

```
confirmedObservedSeconds        = uptimeSeconds + downtimeSeconds
confirmedAvailabilityPercentage = uptimeSeconds / confirmedObservedSeconds * 100
```

`confirmedAvailabilityPercentage` is availability **over the time PSOP actually
observed a verdict** — it ignores the gaps. `null` when there is no confirmed
time at all.

```
availability.percentage = confirmedAvailabilityPercentage
                          ONLY IF the period is fully covered:
                            unknownSeconds == 0
                            && neverSeenSeconds == 0
                            && noDataSeconds == 0
                        = null   otherwise
```

`availability.percentage` is availability **of the whole period**. There is **no
threshold** — any gap at all makes it `null`.

`unavailableReason` (in priority order):

| Reason | When |
|---|---|
| `NO_HISTORY` | no anchor and no in-window events — the period is entirely `NO_DATA`. Both percentages `null`. |
| `NO_CONFIRMED_OBSERVATION` | history exists but `confirmedObservedSeconds == 0` (only `UNKNOWN`/`NEVER_SEEN`/`NO_DATA`). Both percentages `null`. |
| `INCOMPLETE_COVERAGE` | there is confirmed time, but part of the period is `UNKNOWN`/`NEVER_SEEN`/`NO_DATA`. `percentage = null`, `confirmedAvailabilityPercentage` is a number. |
| `null` | the period is fully covered — `percentage` is a number. |

`coveragePercentage = confirmedObservedSeconds / durationSeconds * 100` reports
how much of the period has a verdict.

Numbers are rounded to 4 decimals. Second totals are rounded to whole seconds
(a sub-second gap rounds to 0 and does not trip `INCOMPLETE_COVERAGE`).

## Detection latency

Outage boundaries are PSOP's **detection** time, at the connectivity monitor's
cadence (~60s) — not the exact physical instant the link dropped. Each interval
carries `detectionLatencySeconds` = `detectedAt − lastHeartbeatAt` on the
opening event (how long telemetry was already silent).

A recorder-verified OFFLINE is authoritative and is **not debounced** — PSOP
opens the interval on the first observation. Its `detectionLatencySeconds` is
still the computed `detectedAt − lastHeartbeatAt`: because the recorder reports
the channel state essentially in real time, `lastHeartbeatAt` is within a
second of `detectedAt`, so the value is normally `0` and occasionally rounds to
`1` (whole-second rounding of a sub-second gap). It is **not forced to zero**;
do not rely on an exact-`0` guarantee.

## Real-lab semantics

### Speco N8NRL (no HDD)

- `storage NOT_INSTALLED` and `collection PARTIAL` (optional `queryIPChlInfo`
  gap) **do not** appear in availability at all — `linkState` stays `ONLINE`,
  so the recorder reads 100% available with those conditions present.
- If channel 1 drops, only **Hikvision 01**'s timeline gets an `OFFLINE`
  interval (`source: RECORDER`, `verification: RECORDER_VERIFIED`,
  `observerDeviceName: "NVR Speco"`, `channelNumber: 1`). The NVR and channels
  2/3 stay 100%.

### Hikvision via the recorder

- Recorder-verified OFFLINE opens the interval immediately
  (`detectionLatencySeconds: 0`); the next `online` observation closes it.
- A missing `queryIPChlInfo` firmware enrichment is a collection gap — never an
  outage.

### Lorex

- The Home Center (`DIRECT` `GATEWAY`) has its own ICMP-probe timeline.
- A Lorex **child** camera is `VIA_GATEWAY` with no per-channel observation:
  it has no connectivity events, so `availability.percentage = null`
  (`NO_HISTORY`). Nothing is inferred from the Home Center's state.

## Response contract (shape)

```jsonc
{
  "deviceId": "…",
  "generatedAt": "…",
  "device":     { "id", "name", "externalId", "deviceType", "monitoringMode", "site": { "id","code","name" } },
  "monitoring": { "source", "individualVerification", "observerDeviceId", "observerDeviceName" },

  "period": {
    "requestedFrom": "…", "requestedTo": "…",
    "from": "…", "to": "…",            // effective (to clamped to now)
    "durationSeconds": 604800,
    "window": "7d" | null,
    "clampedToNow": false
  },

  "current": {
    "linkState": "ONLINE" | "OFFLINE" | "UNKNOWN" | "NEVER_SEEN" | null,
    "outageOpen": false,
    "outageStartedAt": null,            // real start of the CURRENT outage, from live history; independent of from/to
    "outageStartedWithinWindow": null,
    "reasonCodes": []
  },

  "availability": {
    "percentage": 99.9741 | null,                 // whole-period; null on ANY gap
    "confirmedAvailabilityPercentage": 99.9741 | null,  // over observed time only
    "unavailableReason": null | "NO_HISTORY" | "NO_CONFIRMED_OBSERVATION" | "INCOMPLETE_COVERAGE",
    "uptimeSeconds": 0, "downtimeSeconds": 0,
    "unknownSeconds": 0, "neverSeenSeconds": 0, "noDataSeconds": 0,
    "confirmedObservedSeconds": 0,
    "coveragePercentage": 100
  },

  "outages": {
    "count": 3,
    "totalDowntimeSeconds": 0,
    "longestSeconds": 0,
    "longest": { …interval } | null,
    "lastOutageAt": "…" | null,
    "lastRecoveryAt": "…" | null,                  // most recent CONFIRMED (OFFLINE->ONLINE) recovery
    "openOutage": { …interval } | null
  },

  "intervals": [
    {
      "startedAt": "…", "endedAt": "…" | null,
      "durationSeconds": 0, "open": false,
      "clipped": { "start": false, "end": false },
      "actualStartedAt": "…", "actualEndedAt": "…" | null,
      "actualDurationSeconds": 0 | null,
      "detectionLatencySeconds": 0 | null,
      "endedByState": "ONLINE" | "UNKNOWN" | "NEVER_SEEN" | null,
      "recoveryConfirmed": false,                  // true ONLY when endedByState === "ONLINE"
      "monitoringSource": "RECORDER_OBSERVED" | "DIRECT" | "GATEWAY_DERIVED" | null,
      "individualVerification": "RECORDER_VERIFIED" | "DIRECT" | "NOT_VERIFIED" | null,
      "observerDeviceId": "…" | null, "observerDeviceName": "…" | null,
      "channelNumber": 1 | null,
      "reasonCodes": ["HEARTBEAT_OVERDUE"],
      "recoveryReasonCodes": [] | null              // populated only when recoveryConfirmed
    }
  ],

  "coverage": {
    "eventCount": 12,
    "firstEventAt": "…" | null, "lastEventAt": "…" | null,
    "hasAnchorBeforeWindow": true,
    "truncated": false
  },

  "limitations": [ "…" ]
}
```

## Differences: connectivity vs health vs collection vs availability

| Dimension | Question | This milestone |
|---|---|---|
| Connectivity (`linkState`) | Is it reachable / observed right now? | **the only input** to downtime |
| Health | Is the equipment operationally healthy? | ignored (never downtime) |
| Collection quality | Did the adapter read everything? | ignored (never downtime) |
| **Availability** | Over a *period*: how much confirmed uptime vs downtime? | **this milestone** |

## Limitations of V1

- **No history / trend series** — a point-in-time computation over one period,
  not a time-bucketed chart.
- **Detection-time resolution** — boundaries are at the monitor cadence (~60s);
  the exact physical drop instant is not stored. `detectionLatencySeconds`
  exposes the known lower bound.
- **Retention-bounded** — reconstruction is only as complete as the
  `DeviceConnectivityEvent` retention window (`CONNECTIVITY_EVENT_RETENTION_DAYS`,
  default 90; DynamoDB TTL prunes expired rows). Windows older than retention
  return `NO_DATA` for the unreconstructable part.
- **Per-query page cap** — 5000 transition rows per call; `coverage.truncated`
  flags when it is hit.
- **No new persistence** — if a caller needs long-horizon SLA rollups, a future
  V2 can materialise closed intervals into a table; V1 deliberately does not.
- **UNKNOWN is never guessed** — a period with only stale observations has
  `percentage = null`, not an optimistic number.
